/**
 * One phone connection, wired end to end: ears hear and route, Claude answers,
 * voice reads the answer back, and every reply byte goes to the phone. This is the
 * turn state machine the web app spread across a Svelte store; here it is one object.
 *
 *   listening ─converse─▶ [holding] ─accept─▶ working ─first voice byte─▶ speaking ─drained─▶ listening
 *
 * Direct mode skips `holding`. In review mode a converse is held: the instruction is
 * read back and offered to the phone, and Gemini — answered at once, never frozen —
 * keeps transcribing, so an "accept" / "reject" / "stop" word is heard live.
 *
 * ears, voice and claude are all long-lived sessions for the connection. Speaking
 * over Claude ends the turn: a different instruction supersedes it, the word "stop"
 * cancels it. Both interrupt Claude and silence the voice while leaving all three
 * sessions warm, so the next turn is fast.
 */

import { appendFile } from 'node:fs/promises';
import { GoogleGenAI } from '@google/genai';
import { openClaude, type Claude } from './claude.ts';
import { correct, CORRECT_MODEL } from './correct.ts';
import { add, load, type Correction } from './corrections.ts';
import { openEars, keyword, type Ears, type Keyword, type ConverseOutcome } from './ears.ts';
import { openVoice, type Voice } from './voice.ts';

export type Mode = 'direct' | 'review' | 'echo';

/** What one turn did and when, on this Mac's clock. Appended to .turns.jsonl. */
interface Turn {
  turn: number;
  mode: Mode;
  heard: string;
  proposed: string; // what Gemini's tool call asked for, before any correction
  corrected: string | null; // what auto-correct made of it, when on
  instruction: string; // what actually ran — corrected, or edited by the user
  approval: 'accepted' | 'rejected' | null;
  said: string;
  speech_end_at: number | null; // caller marked the moment its audio stopped (probe/app)
  converse_at: number | null; // ears routed the instruction
  corrected_at: number | null; // auto-correct came back
  claude_first_at: number | null; // Claude's first token
  voice_out_at: number | null; // first reply byte written to the phone
  reply_in_at: number | null; // phone reported that byte arrived
  voice_ms: number; // reply audio sent, exact (24 kHz Int16 = 48 bytes/ms)
  cost_usd: number | null;
}

/** The phone side of the socket — the only thing this file knows about the network. */
export interface Phone {
  pcm(buf: Buffer): void;
  event(msg: { type: string; text?: string }): void;
}

const TURNS = new URL('./.turns.jsonl', import.meta.url).pathname;

// A turn that never returns to `listening` — Claude died, the voice stalled, or a
// task ran away — would hang the session forever. One ceiling on the whole turn
// catches every cause, since they all look the same: stuck off `listening`. 0 disables.
const TURN_TIMEOUT_MS = Number(process.env['TURN_TIMEOUT_MS'] ?? 180_000);

export class Session {
  private ears!: Ears;
  private voice!: Voice;
  private state: 'listening' | 'holding' | 'working' | 'speaking' = 'listening';
  private turns = 0;
  private turn = this.blank();
  private claudeSessionId: string | null = null;
  private muted = false;
  private claude!: Claude;
  private closed = false;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  // ears + voice take ~1s to connect; audio that arrives meanwhile is held, not dropped.
  private ready = false;
  private backlog: Buffer[] = [];

  private corrections: Correction[] = [];

  private readonly phone: Phone;
  private readonly ai: GoogleGenAI;
  private readonly model: string;
  private readonly mode: Mode;
  private readonly autocorrect: boolean;
  private readonly log: (m: string) => void;

  constructor(phone: Phone, ai: GoogleGenAI, model: string, mode: Mode, autocorrect: boolean, log: (m: string) => void) {
    this.phone = phone;
    this.ai = ai;
    this.model = model;
    this.mode = mode;
    this.autocorrect = autocorrect;
    this.log = log;
  }

  async open(): Promise<void> {
    // Kept in memory as well as on disk, so an edit made this session is used by the
    // next auto-correct without re-reading the file.
    this.corrections = load();
    if (this.corrections.length) this.log(`${this.corrections.length} corrections learned`);

    this.voice = await openVoice(this.ai, this.model, {
      log: this.log,
      isMuted: () => this.muted,
      onPcm: (pcm) => {
        // Only the reply counts as the first byte out; the review readback also plays
        // through this session, and stamping it would time the turn from the wrong sound.
        if (this.state !== 'holding') this.turn.voice_out_at ??= Date.now();
        if (this.state === 'working') this.state = 'speaking';
        this.turn.voice_ms += pcm.length / 48;
        this.phone.pcm(pcm);
      },
      onFlush: (text) => this.ears.context(text),
      // Fires when the voice drains. In review mode the readback drains too — that is
      // not the turn ending, so only end when Claude's reply is what just played.
      onDone: () => { if (this.state === 'working' || this.state === 'speaking') this.endTurn(); },
    });

    this.ears = await openEars(this.ai, this.model, {
      log: this.log,
      onHeard: (text) => {
        this.turn.heard += text;
        this.phone.event({ type: 'user', text });
      },
      onConverse: (instruction) => this.onConverse(instruction),
      onKeyword: (word) => this.onKeyword(word),
      onSilentSpeech: (text) => this.log(`silent speech (Gemini tried to answer): ${text}`),
    }, this.corrections);

    // Claude is a session too, warm for the whole connection. Its callbacks always
    // belong to the turn now running — claude.ts fences an interrupted turn's
    // stragglers — so no correlation guard is needed here.
    this.claude = openClaude({
      log: this.log,
      onText: (text) => {
        this.turn.claude_first_at ??= Date.now();
        this.turn.said += text;
        this.phone.event({ type: 'model', text });
        this.voice.say(text);
      },
      onBlock: (block) => this.phone.event({ type: 'tool', text: block.type === 'tool_use' ? block.name : 'result' }),
      onResult: ({ sessionId, costUsd, error }) => {
        this.claudeSessionId = sessionId;
        this.turn.cost_usd = costUsd;
        if (error) { this.phone.event({ type: 'error', text: error }); this.cancel(`claude error: ${error}`); return; }
        this.voice.finish(); // onDone → endTurn once the audio drains
      },
    });

    this.ready = true;
    if (!this.closed) this.backlog.splice(0).forEach((pcm) => this.ears.send(pcm));
  }

  // --- Phone → session -------------------------------------------------------

  send(pcm: Buffer): void {
    if (this.ready) this.ears.send(pcm);
    else this.backlog.push(pcm);
  }

  /** A text frame from the phone: approve/reject a held turn, mute, or mark a moment. */
  frame(msg: { type?: string; name?: string; at?: number; text?: string; on?: boolean }): void {
    if (msg.type === 'mark' && msg.name === 'reply_in' && typeof msg.at === 'number') this.turn.reply_in_at = msg.at;
    else if (msg.type === 'mark' && msg.name === 'speech_end' && typeof msg.at === 'number') this.turn.speech_end_at = msg.at;
    else if (msg.type === 'mute') this.muted = !!msg.on;
    else if (msg.type === 'approve') this.decide(true, msg.text);
    else if (msg.type === 'reject') this.decide(false);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.disarm();
    this.claude?.close();
    this.ears?.close();
    this.voice?.close();
  }

  // --- Routing ---------------------------------------------------------------

  private onConverse(instruction: string): ConverseOutcome {
    // "yes" / "no" / "stop" are control words, not instructions. Gemini stays live
    // during a hold (so it can hear them), which means it also tries to route them
    // as a converse. Catch that here and treat it as the keyword, so the answer to a
    // hold never becomes a new turn. A bare word only — "yes, delete it" is a real
    // instruction and falls through.
    const control = bareKeyword(instruction);
    if (control) {
      this.onKeyword(control);
      return control === 'reject' ? 'rejected' : 'done';
    }
    // A second real instruction mid-hold is noise; the keywords decide the held one.
    if (this.state === 'holding') return 'rejected';
    // Gemini re-emits converse with the same instruction to say "proceed" once the
    // user approves. That is not a new request — it is the turn we are already on, so
    // ignore it rather than tearing the running turn down as if superseded.
    if (this.state !== 'listening') {
      if (same(instruction, this.turn.instruction)) return 'done';
      this.cancel('superseded'); // a genuinely different instruction is a barge-in
    }
    this.turn.proposed = instruction;
    this.turn.instruction = instruction;
    this.turn.converse_at = Date.now();
    this.log(`converse: ${instruction}`);
    // Answer Gemini now — it must never stay frozen — and let the rest of the turn,
    // which may wait on auto-correct, run on its own.
    void this.propose(instruction);
    return this.mode === 'review' ? 'held' : 'done';
  }

  /** Remember what was really meant, and say so to the Live session that misheard it. */
  private learn(meant: string): void {
    const c: Correction = {
      at: Date.now(),
      heard: this.turn.heard.trim(),
      proposed: this.turn.proposed,
      meant,
    };
    add(c);
    this.corrections.push(c);
    // The Live session's prompt is fixed once open, so tell it the way it accepts
    // mid-session: a model turn it treats as its own prior speech.
    this.ears.context(`Understood — when I hear "${c.heard || c.proposed}", you mean "${meant}".`);
    this.log(`learned: ${c.proposed} → ${meant}`);
  }

  /** Decide the instruction that actually runs, then hold it or run it. */
  private async propose(proposal: string): Promise<void> {
    const turn = this.turn; // fence: a barge-in swaps in a new turn while we await
    this.state = this.mode === 'review' ? 'holding' : 'working';
    this.arm(); // the watchdog covers the correction wait too

    let instruction = proposal;
    if (this.autocorrect) {
      instruction = await correct(this.ai, CORRECT_MODEL, proposal, this.corrections, this.log);
      turn.corrected = instruction;
      turn.corrected_at = Date.now();
      if (instruction !== proposal) this.log(`corrected: ${proposal} → ${instruction}`);
    }
    if (this.turn !== turn || this.closed) return; // cancelled while correcting
    turn.instruction = instruction;

    if (this.mode === 'review') {
      this.voice.say(instruction);
      this.voice.finish();
      this.phone.event({ type: 'approval', text: instruction });
      return;
    }
    this.run(instruction);
  }

  private onKeyword(word: Keyword): void {
    if (this.state === 'holding' && word === 'accept') this.decide(true);
    else if (this.state === 'holding' && word === 'reject') this.decide(false);
    else if ((this.state === 'working' || this.state === 'speaking') && word === 'stop') this.cancel('stop word');
  }

  private decide(accept: boolean, edited?: string): void {
    if (this.state !== 'holding') return;
    this.voice.interrupt(); // stop reading back the instruction
    this.phone.event({ type: 'interrupted' }); // flush the readback already queued on the phone
    if (accept) {
      const instruction = edited?.trim() || this.turn.instruction;
      // An edit is the only evidence of what the user actually said. Keep the pair,
      // teach the running Gemini session immediately, and let the next auto-correct
      // and the next connection start from it.
      if (edited && !same(instruction, this.turn.instruction)) this.learn(instruction);
      this.turn.instruction = instruction;
      this.turn.approval = 'accepted';
      this.log(`accepted: ${instruction}`);
      this.run(instruction);
    } else {
      this.turn.approval = 'rejected';
      this.log('rejected');
      this.endTurn();
    }
  }

  private run(instruction: string): void {
    this.state = 'working';
    this.arm();
    this.claude.send(instruction); // the callbacks wired in open() carry the reply
  }

  // --- Watchdog: one ceiling on the whole turn -------------------------------

  private arm(): void {
    this.disarm();
    if (TURN_TIMEOUT_MS > 0) this.watchdog = setTimeout(() => this.cancel('timeout'), TURN_TIMEOUT_MS);
  }

  private disarm(): void {
    if (this.watchdog) { clearTimeout(this.watchdog); this.watchdog = null; }
  }

  // --- Teardown --------------------------------------------------------------

  /** Interrupt Claude, silence the voice, tell the phone to flush, record the partial turn. */
  private cancel(why: string): void {
    if (this.state === 'listening') return;
    this.log(`cancel (${why})`);
    this.claude.interrupt(); // stops this turn; the session stays warm for the next
    this.voice.interrupt();
    this.phone.event({ type: 'interrupted' });
    this.endTurn();
  }

  private endTurn(): void {
    if (this.state === 'listening') return; // nothing in flight
    this.disarm();
    this.phone.event({ type: 'turn_end' });
    void this.record(this.turn);
    this.turn = this.blank();
    this.state = 'listening';
  }

  private blank(): Turn {
    return {
      turn: ++this.turns, mode: this.mode, heard: '', proposed: '', corrected: null, instruction: '',
      approval: null, said: '', speech_end_at: null, converse_at: null, corrected_at: null,
      claude_first_at: null, voice_out_at: null, reply_in_at: null, voice_ms: 0, cost_usd: null,
    };
  }

  private async record(t: Turn): Promise<void> {
    if (!t.instruction && !t.heard) return; // an empty turn from a bare interrupt
    const d = (a: number | null, b: number | null) => (a && b ? `${b - a}ms` : '—');
    // The stages a user waits through, split apart: Gemini STT+routing, the optional
    // correction, Claude to first token, then Gemini TTS to first byte. speech_end
    // only exists when the caller marks it (probe/app); without it the STT stage reads —.
    const corrected = t.corrected_at ? `correct ${d(t.converse_at, t.corrected_at)}  ` : '';
    this.log(
      `turn ${t.turn} end  stt ${d(t.speech_end_at, t.converse_at)}  ${corrected}` +
      `claude ${d(t.corrected_at ?? t.converse_at, t.claude_first_at)}  tts ${d(t.claude_first_at, t.voice_out_at)}  ` +
      `→phone ${d(t.voice_out_at, t.reply_in_at)}  ${(t.voice_ms / 1000).toFixed(1)}s voice`,
    );
    await appendFile(TURNS, `${JSON.stringify(t)}\n`);
  }
}

/** A converse instruction that is nothing but a control word ("yes", "no", "stop"). */
function bareKeyword(instruction: string): Keyword | null {
  const words = instruction.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  return words.length === 1 ? keyword(words[0]!) : null;
}

/** Two instructions that are the same request but for wording/punctuation drift. */
function same(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return norm(a) === norm(b) && norm(a).length > 0;
}
