/**
 * One phone connection, wired end to end: ears hear, Claude answers, voice reads the
 * answer back, and every reply byte goes to the phone.
 *
 * The state is who holds the floor, and there are only three answers:
 *
 *   user ──final transcript──▶ claude ──voice drained──▶ user
 *     ├──(review)──▶ held ──yes/edit──▶ claude      claude ──partial──▶ user (barge-in)
 *     └──typed─────────────▶ claude
 *
 * A finished transcript means something different in each, which is why there are
 * exactly three: the instruction, the answer to a held question, or — because a
 * partial has already cancelled the turn — the instruction that replaces it. A typed
 * instruction has none of that ambiguity: it cannot have been misheard, so it is never
 * corrected and never held, and it runs the moment it arrives.
 *
 * Audio in is what buys audio out. The ears open on the first microphone buffer rather
 * than on connect, and the voice speaks only for a connection that has ears — so a
 * connection that is only typed to never opens a Gemini session in either direction,
 * and nothing has to be told which kind of connection it is.
 *
 * ears and claude are long-lived sessions for the connection, so an interrupt cancels
 * a turn and leaves both warm; the next one is fast. The voice is not a session at
 * all — one request per sentence — so there is nothing there for an interrupt to
 * damage and nothing to reopen when one fails.
 */

import { appendFile } from 'node:fs/promises';
import { GoogleGenAI } from '@google/genai';
import { openClaude, type Claude } from './claude.ts';
import { save as saveClip } from './clips.ts';
import { correct, CORRECT_MODEL } from './correct.ts';
import { add, load, type Correction } from './corrections.ts';
import { openEars, keyword, type Ears, type Keyword } from './ears.ts';
import { state } from './paths.ts';
import { openVoice, type Voice } from './voice.ts';

export type Mode = 'direct' | 'review';

/** What one turn did and when, on this Mac's clock. Appended to .duck-talk/turns.jsonl. */
export interface Turn {
  turn: number;
  mode: Mode;
  /** The Claude session this turn belongs to — what groups turns into a chat, and
   *  what `?resume=` takes to carry one on. Null before Claude's first result. */
  session_id: string | null;
  heard: string;
  /** The audio `heard` was made from, filed by clips.ts under this same number
   *  (which is `heard_at`). Null for a typed turn — nothing was heard. */
  clip: number | null;
  proposed: string; // what Gemini's tool call asked for, before any correction
  corrected: string | null; // what auto-correct made of it, when on
  instruction: string; // what actually ran — corrected, or edited by the user
  approval: 'accepted' | 'rejected' | null;
  said: string;
  speech_end_at: number | null; // caller marked the moment its audio stopped (probe/app)
  partial_last_at: number | null; // last interim transcript before the final
  heard_at: number | null; // the utterance was finished — the instruction exists
  corrected_at: number | null; // auto-correct came back
  /** The instruction went to Claude. In review mode everything before this is a
   *  human deciding, which is not latency; timing Claude from here keeps the two apart. */
  ran_at: number | null;
  claude_start_at: number | null; // Claude opened its first block of the turn
  claude_opens: string | null; // and what it was: text, thinking, tool_use
  claude_first_at: number | null; // Claude's first token
  tts_sent_at: number | null; // first sentence handed to the voice model
  voice_out_at: number | null; // first reply byte written to the phone
  reply_in_at: number | null; // phone reported that byte arrived
  voice_ms: number; // reply audio sent, exact (24 kHz Int16 = 48 bytes/ms)
  cost_usd: number | null;
}

/** The phone side of the socket — the only thing this file knows about the network. */
export interface Phone {
  pcm(buf: Buffer): void;
  /** `partial` marks text that replaces the current line instead of extending it.
   *  `session` rides on `turn_end`: the chat this connection turned out to be in, so
   *  the next one the phone opens can carry it on. `clip` rides on `approval` and on
   *  `turn_end`: the utterance this turn was made from, playable and correctable. */
  event(msg: { type: string; text?: string; partial?: boolean; session?: string | null; clip?: number | null }): void;
}

// A turn that never returns to `listening` — Claude died, the voice stalled, or a
// task ran away — would hang the session forever. One ceiling on the whole turn
// catches every cause, since they all look the same: stuck off `listening`. 0 disables.
const TURN_TIMEOUT_MS = Number(process.env['TURN_TIMEOUT_MS'] ?? 180_000);

// The phone holds the mic open and sends every buffer, silence included, so a pause
// this long is not a quiet user — it is a phone that stopped sending. Well past the
// tens of milliseconds a capture buffer takes, well short of anything worth missing.
const AUDIO_GAP_MS = 2_000;

export class Session {
  /** Null until the phone sends its first microphone buffer — see `listen`. */
  private ears: Ears | null = null;
  private voice!: Voice;
  private state: 'user' | 'held' | 'claude' = 'user';
  private turns = 0;
  private turn = this.blank();
  private claude!: Claude;
  private sessionId: string | null = null;
  private closed = false;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  // ears takes ~1s to connect; audio that arrives meanwhile is held, not dropped.
  private opening = false;
  private backlog: Buffer[] = [];
  // Whether the phone is still sending microphone audio at all — see `hearing`.
  private audioAt = 0;
  private deaf = false;
  private gap: ReturnType<typeof setTimeout> | null = null;

  private corrections: Correction[] = [];

  private readonly phone: Phone;
  private readonly ai: GoogleGenAI;
  private readonly sttModel: string;
  private readonly voiceModel: string;
  private readonly mode: Mode;
  private readonly autocorrect: boolean;
  private readonly readback: boolean;
  /** A past chat to carry on, rather than starting one. */
  private readonly resume: string | undefined;
  private readonly log: (m: string) => void;

  constructor(
    phone: Phone,
    ai: GoogleGenAI,
    mode: Mode,
    opts: { sttModel: string; voiceModel: string; autocorrect: boolean; readback: boolean; resume?: string },
    log: (m: string) => void,
  ) {
    this.resume = opts.resume;
    this.phone = phone;
    this.ai = ai;
    this.mode = mode;
    this.sttModel = opts.sttModel;
    this.voiceModel = opts.voiceModel;
    this.autocorrect = opts.autocorrect;
    this.readback = opts.readback;
    this.log = log;
  }

  /**
   * Everything that costs nothing until it is used: the corrections, the voice (which
   * has no connection) and Claude (which is warm but silent until sent to). Nothing
   * here awaits, so an instruction arriving with the handshake finds a session ready
   * for it. The ears are not here — they wait for audio.
   */
  open(): void {
    // Kept in memory as well as on disk, so an edit made this session is used by the
    // next auto-correct without re-reading the file.
    this.corrections = load();
    if (this.corrections.length) this.log(`${this.corrections.length} corrections learned`);

    // The voice needs no connection, so there is nothing to await and nothing that
    // can fail here.
    this.voice = openVoice(this.ai, this.voiceModel, {
      log: this.log,
      onPcm: (pcm) => {
        // Only the reply counts as the first byte out; the review readback is read the
        // same way, and stamping it would time the turn from the wrong sound.
        if (this.state !== 'held') this.turn.voice_out_at ??= Date.now();
        this.turn.voice_ms += pcm.length / 48;
        this.phone.pcm(pcm);
      },
      // Same guard as the first byte out, for the same reason: a review readback is
      // read through this voice too, and timing the turn from it is the wrong sound.
      onSay: () => { if (this.state !== 'held') this.turn.tts_sent_at ??= Date.now(); },
      // Fires when the voice drains. In review mode the readback drains too — that is
      // not the turn ending, so only end when Claude's reply is what just played.
      onDone: () => { if (this.state === 'claude') this.endTurn(); },
    });

    // Claude is a session too, warm for the whole connection. Its callbacks always
    // belong to the turn now running — claude.ts fences an interrupted turn's
    // stragglers — so no correlation guard is needed here.
    this.claude = openClaude({
      resume: this.resume,
      log: this.log,
      onStart: (kind) => {
        this.turn.claude_start_at ??= Date.now();
        this.turn.claude_opens ??= kind;
      },
      onText: (text) => {
        this.turn.claude_first_at ??= Date.now();
        this.turn.said += text;
        this.phone.event({ type: 'model', text });
        // Read aloud only to someone who spoke. A typed instruction wants its answer
        // on the screen it was typed on.
        if (this.ears) this.voice.say(text);
      },
      // A `tool` event with a name means Claude started that tool; without one, it
      // finished. Only the running name is worth showing, so the phone needs no
      // history and no magic word to compare against.
      onBlock: (block) => this.phone.event(block.type === 'tool_use' ? { type: 'tool', text: block.name } : { type: 'tool' }),
      onResult: ({ sessionId, costUsd, error }) => {
        // Stable for the life of the session, resumed or fresh — so once the first
        // result lands, every turn on this connection knows which chat it is in.
        this.sessionId = sessionId;
        this.turn.cost_usd = costUsd;
        if (error) { this.phone.event({ type: 'error', text: error }); this.cancel(`claude error: ${error}`); return; }
        // With a voice, the turn ends when the audio has been heard; without one,
        // Claude finishing is the whole of it.
        if (this.ears) this.voice.finish(); // onDone → endTurn once the audio drains
        else this.endTurn();
      },
    });
  }

  /**
   * Open the ears, once, on the first audio — so a connection that is only typed to
   * never opens a Gemini session at all, and one that is spoken to needs no flag.
   *
   * Failing here costs the microphone and nothing else: the connection stays up and
   * can still be typed to, which is exactly what the phone should offer if Gemini is
   * unreachable.
   */
  private async listen(): Promise<void> {
    if (this.ears || this.opening || this.closed) return;
    this.opening = true;
    try {
      const ears = await this.openEars();
      if (this.closed) return void ears.close();
      this.ears = ears;
      this.backlog.splice(0).forEach((pcm) => ears.send(pcm));
    } catch (e) {
      this.log(`ears failed: ${e}`);
      this.phone.event({ type: 'error', text: `could not start listening: ${e}` });
    } finally {
      this.opening = false;
    }
  }

  /**
   * The two transcript signals settle who holds the floor: a partial while Claude is
   * talking is the user talking over it, and the final that follows is the next
   * instruction.
   */
  private openEars(): Promise<Ears> {
    return openEars(this.ai, this.sttModel, {
      log: this.log,
      onPartial: (text) => {
        // Unambiguous here in a way the routing ears never were: a partial can only
        // follow the previous final, so any partial while Claude speaks is a new
        // utterance, never the tail of the one that started the turn.
        if (this.state === 'claude') this.cancel('spoke over the reply');
        this.turn.heard = text;
        // The last one before the final says how long Gemini took to decide the
        // utterance was over — the one wait an endpointing setting would change.
        this.turn.partial_last_at = Date.now();
        this.phone.event({ type: 'user', text, partial: true });
      },
      onFinal: (text, clip) => {
        this.turn.heard = text;
        // Still the whole utterance, so still a replacement — `false` only says no
        // further revision is coming.
        this.phone.event({ type: 'user', text, partial: false });
        this.heard(text, clip); // the transcript is the instruction
      },
    }, this.corrections);
  }

  // --- Phone → session -------------------------------------------------------

  send(pcm: Buffer): void {
    this.hearing();
    if (this.ears) return this.ears.send(pcm);
    // The first buffer is what opens the ears; the ~1s that takes is held here.
    this.backlog.push(pcm);
    void this.listen();
  }

  /**
   * Say when the microphone goes away and when it comes back.
   *
   * From here a silent user and a phone that has stopped sending look identical —
   * except that they don't, because the phone streams silence too. So a gap in the
   * bytes is the phone itself going quiet: locked and suspended, interrupted by a
   * call, or killed. This is the only place that can see it; the phone's own screen
   * is off at exactly the moment worth watching.
   */
  private hearing(): void {
    const now = Date.now();
    if (this.deaf) {
      this.log(`audio back after ${((now - this.audioAt) / 1000).toFixed(1)}s`);
      this.deaf = false;
    }
    this.audioAt = now;
    if (this.gap) clearTimeout(this.gap);
    this.gap = setTimeout(() => {
      this.deaf = true;
      this.log('audio stopped — the phone is not sending');
    }, AUDIO_GAP_MS);
  }

  /**
   * A text frame: an instruction, a held one approved, or a mark.
   *
   * There is no reject frame. Refusing a held instruction is not doing anything with
   * it — say "no", or hang up — so the only refusal that needs a message is the
   * spoken one, and that arrives as a transcript like any other.
   */
  frame(msg: { type?: string; name?: string; at?: number; text?: string }): void {
    if (msg.type === 'mark' && msg.name === 'reply_in' && typeof msg.at === 'number') this.turn.reply_in_at = msg.at;
    else if (msg.type === 'mark' && msg.name === 'speech_end' && typeof msg.at === 'number') this.turn.speech_end_at = msg.at;
    else if (msg.type === 'text' && typeof msg.text === 'string') this.typed(msg.text);
    else if (msg.type === 'approve') this.decide(true, msg.text);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.disarm();
    if (this.gap) { clearTimeout(this.gap); this.gap = null; }
    this.claude?.close();
    this.ears?.close();
    this.voice?.close();
  }

  // --- Routing ---------------------------------------------------------------

  /** A finished utterance: a decision if it is only a control word, else an instruction. */
  private heard(said: string, clip: Buffer | null): void {
    // "yes" / "no" / "stop" answer a question rather than asking one. A bare word
    // only — "yes, delete it" is a real instruction and falls through.
    const control = bareKeyword(said);
    if (control) return this.onKeyword(control);
    // Mid-hold, the keywords decide; anything else said is noise.
    if (this.state === 'held') return;
    // Speaking over Claude already cancelled the turn on the first partial; this is
    // the instruction that replaces it.
    this.turn.proposed = said;
    this.turn.instruction = said;
    this.turn.heard_at = Date.now();
    // The moment the utterance finished is both the turn's stamp and the clip's name,
    // so the audio is filed by the number that already identifies it. Only for speech
    // that became an instruction: a keyword or a mid-hold noise has nothing to correct.
    if (clip) {
      this.turn.clip = this.turn.heard_at;
      try { saveClip(clip, this.turn.clip); } catch (e) { this.log(`clip failed: ${e}`); this.turn.clip = null; }
    }
    this.log(`heard: ${said}`);
    // Runs on its own because auto-correct may need a moment first.
    void this.propose(said).catch((e) => this.log(`propose failed: ${e}`));
  }

  /**
   * A typed instruction. It cannot have been misheard, so there is nothing to correct
   * and nothing to review — it is final the moment it arrives, and runs.
   */
  private typed(said: string): void {
    const instruction = said.trim();
    if (!instruction || this.state !== 'user') return;
    this.turn.proposed = instruction;
    this.turn.instruction = instruction;
    this.turn.heard_at = Date.now();
    this.log(`typed: ${instruction}`);
    this.run(instruction);
  }

  /** Remember what was really meant, so the next transcription starts from it. */
  private learn(meant: string): void {
    const c: Correction = {
      at: Date.now(),
      heard: this.turn.heard.trim(),
      proposed: this.turn.proposed,
      meant,
      // What the mishearing sounded like. This is the pair's evidence, and it is why
      // clips.ts keeps a referenced clip for good while a loose one ages out.
      ...(this.turn.clip ? { clip: this.turn.clip } : {}),
    };
    add(c);
    this.corrections.push(c);
    this.log(`learned: ${c.proposed} → ${meant}`);
  }

  /** Decide the instruction that actually runs, then hold it or run it. */
  private async propose(proposal: string): Promise<void> {
    const turn = this.turn; // fence: a barge-in swaps in a new turn while we await
    this.state = this.mode === 'review' ? 'held' : 'claude';
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
      // The phone shows the instruction, so speaking it too is repetition the user
      // waits through. Off unless asked for — `?readback=1` is for deciding by ear,
      // without looking at the screen.
      if (this.readback) {
        this.voice.say(instruction);
        this.voice.finish();
      }
      // With the clip, so the phone can play what was heard before deciding on it.
      this.phone.event({ type: 'approval', text: instruction, clip: turn.clip });
      return;
    }
    this.run(instruction);
  }

  private onKeyword(word: Keyword): void {
    if (this.state === 'held' && word === 'accept') this.decide(true);
    else if (this.state === 'held' && word === 'reject') this.decide(false);
    else if (this.state === 'claude' && word === 'stop') this.cancel('stop word');
  }

  private decide(accept: boolean, edited?: string): void {
    if (this.state !== 'held') return;
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
    this.state = 'claude';
    this.turn.ran_at = Date.now();
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
    if (this.state === 'user') return;
    this.log(`cancel (${why})`);
    this.claude.interrupt(); // stops this turn; the session stays warm for the next
    this.voice.interrupt();
    this.phone.event({ type: 'interrupted' });
    this.endTurn();
  }

  private endTurn(): void {
    if (this.state === 'user') return; // nothing in flight
    this.disarm();
    // Which chat this turned out to be, so the next connection the phone opens can
    // carry it on — including one it opens to type into.
    this.phone.event({ type: 'turn_end', session: this.sessionId, clip: this.turn.clip });
    void this.record(this.turn).catch((e) => this.log(`record failed: ${e}`));
    this.turn = this.blank();
    this.state = 'user';
  }

  private blank(): Turn {
    return {
      turn: ++this.turns, mode: this.mode, session_id: null, heard: '', clip: null, proposed: '', corrected: null, instruction: '',
      approval: null, said: '', speech_end_at: null, partial_last_at: null, heard_at: null, corrected_at: null,
      ran_at: null, claude_start_at: null, claude_opens: null, claude_first_at: null, tts_sent_at: null,
      voice_out_at: null, reply_in_at: null, voice_ms: 0, cost_usd: null,
    };
  }

  private async record(t: Turn): Promise<void> {
    if (!t.instruction && !t.heard) return; // an empty turn from a bare interrupt
    // Stamped here rather than when the turn began: a turn interrupted before Claude
    // answered still belongs to the chat, and by now the id is known.
    t.session_id = this.sessionId;
    const d = (a: number | null, b: number | null) => (a && b ? `${b - a}ms` : '—');
    // Every stage a user waits through, and each one is a subtraction between two
    // stamps on this Mac's clock. `stt` needs the caller to mark speech_end
    // (probe/app) and reads — without it; `final` is Gemini deciding the utterance
    // ended, which needs no mark at all. `claude` is split at its first block, so
    // the API's share and the model's own thinking are separate numbers, and
    // `buffer` is text waiting for a sentence boundary rather than for the voice.
    const corrected = t.corrected_at ? `correct ${d(t.heard_at, t.corrected_at)}  ` : '';
    // Review mode only: the gap between the instruction existing and it being sent
    // is a person deciding, and putting it in the Claude number would hide both.
    const held = t.approval ? `held ${d(t.corrected_at ?? t.heard_at, t.ran_at)}  ` : '';
    const claude = t.claude_start_at
      ? `claude ${d(t.ran_at, t.claude_start_at)}+${d(t.claude_start_at, t.claude_first_at)} (${t.claude_opens})`
      : `claude ${d(t.ran_at, t.claude_first_at)}`;
    this.log(
      `turn ${t.turn} end  stt ${d(t.speech_end_at, t.heard_at)}  final ${d(t.partial_last_at, t.heard_at)}  ${corrected}${held}` +
      `${claude}  buffer ${d(t.claude_first_at, t.tts_sent_at)}  tts ${d(t.tts_sent_at, t.voice_out_at)}  ` +
      `→phone ${d(t.voice_out_at, t.reply_in_at)}  ${(t.voice_ms / 1000).toFixed(1)}s voice`,
    );
    await appendFile(state('turns.jsonl'), `${JSON.stringify(t)}\n`);
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
