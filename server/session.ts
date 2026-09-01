/**
 * One phone connection, wired end to end: ears hear, Claude answers, voice reads the
 * answer back, and every reply byte goes to the phone.
 *
 * The state is who holds the floor, and there are only three answers:
 *
 *   user ──final transcript──▶ claude ──voice drained──▶ user
 *     ├──(review)──▶ held ──yes/edit──▶ claude      claude ──new utterance──▶ user (barge-in)
 *     └──typed─────────────▶ claude                 claude ──continuation──▶ user (retract)
 *
 * A finished transcript means something different in each, which is why there are
 * exactly three: the instruction, the answer to a held question, or — because a
 * partial has already cancelled the turn — the instruction that replaces it. Speech
 * during a turn splits on the ears' own JOIN decision: a new utterance is a barge-in
 * and cancels, a continuation is the instruction still being spoken and takes the
 * turn back to run again whole — see `retract`. A typed instruction has none of that
 * ambiguity: it cannot have been misheard, so it is never corrected and never held,
 * and it runs the moment it arrives.
 *
 * Audio in is what buys audio out. The ears open on the first microphone buffer rather
 * than on connect, and the voice speaks only for a connection that has ears — so a
 * connection that is only typed to never opens a Gemini session in either direction,
 * and nothing has to be told which kind of connection it is.
 *
 * ears is a long-lived session for the connection and claude one for the *chat* —
 * claimed on open, released on close, and still working after the socket is gone —
 * so an interrupt cancels a turn and leaves both warm; the next one is fast. The
 * voice is not a session at all — one request per sentence — so there is nothing
 * there for an interrupt to damage and nothing to reopen when one fails.
 */

import { GoogleGenAI } from '@google/genai';
import { claim, DEFAULTS, release, type Claude, type ClaudeCallbacks, type PermissionMode } from './claude.ts';
import { save as saveClip } from './clips.ts';
import { correct, CORRECT_MODEL } from './correct.ts';
import { add, load, type Correction } from './corrections.ts';
import { openEars, keyword, type Ears, type Keyword } from './ears.ts';
import { append, type Mode, type Turn } from './turns.ts';
import { openVoice, type Voice } from './voice.ts';

export type { Mode, Turn };

/** The phone side of the socket — the only thing this file knows about the network. */
export interface Phone {
  pcm(buf: Buffer): void;
  /** `partial` marks text that replaces the current line instead of extending it.
   *  `session` rides on `turn_end`: the chat this connection turned out to be in, so
   *  the next one the phone opens can carry it on. `clip` rides on the final `user`
   *  event: the audio that utterance was heard from, playable and correctable.
   *  `parent` rides on `tool`: the Agent call it happened inside, null for Claude's
   *  own — so a subagent's tools are shown as its own and its finishing one does not
   *  read as the Agent finishing. `retract` rides on `interrupted`: the turn was
   *  taken back, so what it already put on the screen comes off — a warm Claude can
   *  answer a fragment inside the pause that made it, and that answer must not sit
   *  in the transcript beside the real one. `turn_start` carries nothing at all: it
   *  is the instruction having been dispatched, which is the earliest anything can
   *  honestly say the turn is running — see `run`. */
  event(msg: { type: string; text?: string; partial?: boolean; session?: string | null; clip?: number | null; parent?: string | null; retract?: boolean }): void;
}

// A turn that never returns to `listening` — Claude died, the voice stalled, or a
// task ran away — would hang the session forever. What catches every cause is that
// they all look the same: nothing arrives, ever again.
//
// So this is silence, not length. Anything Claude produces re-arms it, and what trips
// it is producing nothing at all for this long. A ceiling on the whole turn was the
// wrong question: a fan-out of subagents legitimately works for many minutes, and the
// ceiling interrupted it mid-work and threw the turn away.
//
// Longer than the 180s that ceiling used, because it is now a different measurement
// and the old number does not carry over. What has to fit inside it is the longest
// gap between two signs of life, and the longest is one tool running — a test suite
// or a build says nothing between its `tool_use` and its `tool_result`. 0 disables.
const QUIET_MS = Number(process.env['TURN_QUIET_MS'] ?? 300_000);

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
  /** The callbacks handed to `claim` — this session's proof of attachment. */
  private audience!: ClaudeCallbacks;
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

  // What Claude has been asked to be. Kept here as well as in claude.ts so a turn that
  // never reaches a result — interrupted, or stopped — still records what it ran as.
  private model = DEFAULTS.model;
  private permission: string = DEFAULTS.permission;
  private effort: string | null = DEFAULTS.effort;

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

    // Claude is a session too, warm for the whole connection — claimed rather than
    // opened, so resuming a chat whose session is still working reattaches to it and
    // the running turn is replayed through these callbacks. They always belong to
    // the turn now running — claude.ts fences an interrupted turn's stragglers — so
    // no correlation guard is needed here. The object is kept: it is this session's
    // proof of attachment, which `release` requires so a socket that closed late
    // cannot strip the callbacks off whoever attached after it.
    this.audience = {
      log: this.log,
      onStart: (kind) => {
        // A turn this connection never sent: a background task's narration, or a
        // turn replayed by attaching to a session mid-turn. Claiming the floor is
        // the whole of handling either: everything downstream (the voice, the
        // phone, turn_end, the record that skips an instructionless turn) already
        // treats a claimed floor as a turn, barge-in included. A held floor is not
        // claimed: the review card is a question, and the narration's text is
        // dropped by the guard in onText.
        if (this.state === 'user' && !this.closed) {
          // What is known: a turn opened a block here with no instruction outstanding.
          // Which of the two ways that happens — attaching to a session mid-turn, or a
          // background task's narration — this cannot see, so it does not say.
          this.log(`claude opened ${kind} with nothing sent`);
          this.state = 'claude';
          this.arm();
        }
        this.turn.claude_start_at ??= Date.now();
        this.turn.claude_opens ??= kind;
        // The one opening that would otherwise show nothing: text is the answer
        // arriving and a tool announces itself by name, but a model that thinks first
        // says nothing for as long as it thinks — 22 seconds on turn 15 of this
        // project's own log. Sent as a tool so it draws with the chip that exists.
        if (kind === 'thinking') this.phone.event({ type: 'tool', text: 'Thinking' });
      },
      onText: (text) => {
        if (this.state !== 'claude') return; // a narration must not talk over a held card
        this.arm(); // words are proof of life
        this.turn.claude_first_at ??= Date.now();
        this.turn.said += text;
        this.phone.event({ type: 'model', text });
        // Read aloud only to someone who spoke. A typed instruction wants its answer
        // on the screen it was typed on.
        if (this.ears) this.voice.say(text);
      },
      // A `tool` event with a name means Claude started that tool; without one, it
      // finished. Only the running name is worth showing, so the phone needs no
      // history and no magic word to compare against. `parent` says whose it is.
      onBlock: (block) => {
        this.arm(); // a fan-out works for minutes without a word, and is not stuck
        // One event either way: an absent `text` is JSON's own way of saying no name,
        // so a tool starting and a tool finishing take the same line rather than two.
        this.phone.event({ type: 'tool', text: block.name ?? undefined, parent: block.parent });
      },
      onError: (text) => this.phone.event({ type: 'error', text }),
      onResult: ({ sessionId, costUsd, error, model, permission, effort }) => {
        // Stable for the life of the session, resumed or fresh — so once the first
        // result lands, every turn on this connection knows which chat it is in.
        this.sessionId = sessionId;
        this.turn.cost_usd = costUsd;
        // From claude.ts rather than from the frame that asked: what answered, not what
        // was requested — a `set` that was refused leaves this on the old value.
        this.turn.model = this.model = model;
        this.turn.permission = this.permission = permission;
        this.turn.effort = this.effort = effort;
        if (error) { this.phone.event({ type: 'error', text: error }); this.cancel(`claude error: ${error}`); return; }
        // With a voice, the turn ends when the audio has been heard; without one,
        // Claude finishing is the whole of it. A closed session has no voice to
        // drain — the turn outlived its socket, and ends (and is recorded) here.
        if (this.ears && !this.closed) this.voice.finish(); // onDone → endTurn once the audio drains
        else this.endTurn();
      },
    };
    this.claude = claim(this.resume, this.audience);
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
      onPartial: (text, continuing) => {
        // Speech during a turn is one of two things, and the ears already know which:
        // `continuing` is their own JOIN decision, so this utterance is the rest of
        // the instruction that started the turn — take the turn back and wait for the
        // fuller sentence. Anything else is a new utterance over the reply: barge-in.
        if (this.state === 'claude') {
          // The reason given is the signal that caused it — the ears' own JOIN
          // decision — rather than what the speaker is presumed to be doing.
          if (continuing) this.retract();
          else this.cancel('partial while claude, not continuing');
        }
        this.turn.heard = text;
        // The first partial is when words first reached the screen, the last one is
        // how long Gemini then took to decide the utterance was over — the one wait
        // an endpointing setting would change. Stamped after the cancel above, so a
        // barge-in's first partial belongs to the turn it starts, not the one it ends.
        this.turn.partial_first_at ??= Date.now();
        this.turn.partial_last_at = Date.now();
        this.phone.event({ type: 'user', text, partial: true });
      },
      onFinal: (text, clip) => {
        this.turn.heard = text;
        // The clip belongs to the utterance, not to the turn, so it is kept and
        // announced here — with the text it is the sound of, and before anything is
        // decided about it. A turn is stopped as often as it is finished, and a phone
        // that only learned of the clip at the end would miss every one of those.
        if (clip) this.keep(clip);
        // Still the whole utterance, so still a replacement — `false` only says no
        // further revision is coming.
        this.phone.event({ type: 'user', text, partial: false, clip: this.turn.clip });
        this.heard(text); // the transcript is the instruction
      },
      // Gemini caps a Live session's length and there is no way around it on this
      // model, so losing the ears is a matter of when. The recovery is the open path,
      // run again: the very next microphone buffer reopens through `listen`, which
      // already holds audio in a backlog, re-sends the vocabulary, and tells the
      // phone if it fails. Nothing else to keep in step.
      // ears.ts already logs the close and its code; what happens next is this
      // object's own state and not an observation, so it is not narrated twice.
      onClosed: () => {
        if (this.closed) return;
        this.ears = null;
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
      // The observation, not a diagnosis of it. This used to read "the phone is not
      // sending", which is one of several things a gap can mean and was the wrong one
      // the first time it mattered: the phone was rebuilding its audio graph and came
      // back. What is known here is how long no bytes have arrived for.
      this.log(`no audio for ${(AUDIO_GAP_MS / 1000).toFixed(1)}s`);
    }, AUDIO_GAP_MS);
  }

  /**
   * A text frame: an instruction, a held one approved, or a mark.
   *
   * There is no reject frame. Refusing a held instruction is not doing anything with
   * it — say "no", or hang up — so the only refusal that needs a message is the
   * spoken one, and that arrives as a transcript like any other.
   */
  frame(msg: { type?: string; name?: string; note?: string; at?: number; ms?: number; text?: string; model?: string; permission?: string; effort?: string }): void {
    if (msg.type === 'mark' && msg.name === 'reply_in' && typeof msg.at === 'number') this.turn.reply_in_at = msg.at;
    // Only while a turn is in flight: the mark trails its final by a beat, so after a
    // final that itself ended things — a bare "no", a "stop" said to a quiet room —
    // it would otherwise stamp the blank turn that follows. Last one wins, because a
    // joined utterance sends a mark per fragment and the sentence ends at the last.
    else if (msg.type === 'mark' && msg.name === 'speech_end' && typeof msg.at === 'number') { if (this.state !== 'user') this.turn.speech_end_at = msg.at; }
    // Any other mark is a moment only the phone can see — a mute, its audio graph
    // being rebuilt under it — narrated here so it lands beside everything else on the
    // one clock, and recorded nowhere. One branch rather than one per name: the phone
    // says what happened and who caused it, and this does not have to know the list.
    else if (msg.type === 'mark' && typeof msg.name === 'string') this.log(`phone: ${msg.name}${msg.note ? ` — ${msg.note}` : ''}`);
    // What the speaker has really played of this turn's reply. The only honest answer
    // to "was it heard": everything else here is arithmetic over what was sent.
    //
    // Recorded only while a turn is in flight, for the reason speech_end is: the
    // report trails the audio by a beat, and on an ordinary turn the wait below has
    // already ended on its own arithmetic — so a report arriving after that would
    // stamp the blank turn that follows with the last turn's number. The case this
    // exists for is the other one, where the speaker falls silent seconds early and
    // says so while the turn is very much still running.
    else if (msg.type === 'played' && typeof msg.ms === 'number') {
      if (this.state !== 'user') this.turn.heard_ms = msg.ms;
      this.voice.heard(msg.ms);
    }
    else if (msg.type === 'text' && typeof msg.text === 'string') this.typed(msg.text);
    else if (msg.type === 'approve') this.decide(true, msg.text);
    // The stop button, as a frame — the spoken "stop" of a typed or followed turn.
    // The phone closes the socket right after, but the two are separate acts on the
    // wire on purpose: stopping the work and hanging up can be decoupled later.
    else if (msg.type === 'stop') this.cancel('stop frame');
    else if (msg.type === 'claude') this.be(msg.model, msg.permission, msg.effort);
  }

  /**
   * What Claude is: which model answers, what it may do, and how hard it thinks.
   *
   * Sent when a socket opens and again whenever it is changed on the phone, so there is
   * one path rather than an initial setting and a separate way to change it. All hold
   * from the next turn — see `Claude.set` — so this never has to wait for anything, and
   * repeating a value already set does nothing.
   */
  private be(model?: string, permission?: string, effort?: string): void {
    if (model) this.turn.model = this.model = model;
    if (permission) this.turn.permission = this.permission = permission;
    // 'default' means the CLI's own choice, which the record writes as null — the same
    // convention the model follows.
    if (effort) this.turn.effort = this.effort = effort === 'default' ? null : effort;
    this.claude.set(model, permission as PermissionMode | undefined, effort);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.disarm();
    if (this.gap) { clearTimeout(this.gap); this.gap = null; }
    // Released, not closed: a busy session stays in the pool and finishes its work,
    // reattachable by the next `?resume=` — see claude.ts.
    if (this.claude) release(this.claude, this.audience);
    this.ears?.close();
    this.voice?.close();
  }

  // --- Routing ---------------------------------------------------------------

  /** A finished utterance: a decision if it is only a control word, else an instruction. */
  private heard(said: string): void {
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
    this.log(`heard: ${said}`);
    // Runs on its own because auto-correct may need a moment first.
    void this.propose(said).catch((e) => this.log(`propose failed: ${e}`));
  }

  /**
   * File this utterance's audio, named by the moment it finished. Every utterance gets
   * one, keywords included: "yes" can be misheard as readily as anything else, and one
   * rule with no exception in it is cheaper than the exception. clips.ts bounds what
   * that costs.
   */
  private keep(clip: Buffer): void {
    const id = Date.now();
    try {
      saveClip(clip, id);
      this.turn.clip = id;
    } catch (e) {
      this.log(`clip failed: ${e}`);
    }
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
      this.phone.event({ type: 'approval', text: instruction });
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
    // The turn is running, said the moment it is true rather than at Claude's first
    // block ~1.5s later — the longest silent stretch a user waits through, and the
    // phone's cue to commit the utterance and start the filler. Safe here where it
    // was not on the final transcript: a keyword-only final never reaches this line,
    // and every turn that does is guaranteed a closer (turn_end or interrupted).
    this.phone.event({ type: 'turn_start' });
    this.arm();
    this.claude.send(instruction); // the callbacks wired in open() carry the reply
  }

  // --- Watchdog: the turn is alive, or nothing is arriving --------------------

  /** The turn is alive as of now. Called to start it and again on every sign of life,
   *  so one method means one thing and there is no second timer to keep in step. */
  private arm(): void {
    if (this.closed) return; // a drain narrates into a closed session; no timer for it
    this.disarm();
    if (QUIET_MS > 0) this.watchdog = setTimeout(() => this.cancel(`nothing from claude for ${QUIET_MS / 1000}s`), QUIET_MS);
  }

  private disarm(): void {
    if (this.watchdog) { clearTimeout(this.watchdog); this.watchdog = null; }
  }

  // --- Teardown --------------------------------------------------------------

  /**
   * Take the turn back: the instruction that started it is still being spoken.
   *
   * Everything a cancel does except ending the turn — the record, the clip and the
   * turn number stay, the joined final re-runs the same turn with the whole sentence,
   * and the phone commits one line instead of one per fragment. What ran on the
   * fragment is wiped from the record, because the numbers that matter are the ones
   * from the instruction that was actually meant.
   */
  private retract(): void {
    this.log('retract (partial while claude, continuing)');
    this.claude.interrupt();
    this.voice.interrupt();
    this.phone.event({ type: 'interrupted', retract: true });
    this.disarm();
    const t = this.turn;
    t.said = ''; // a reply this fast is to the fragment, and the fragment is gone
    t.corrected = t.corrected_at = t.ran_at = null;
    t.claude_start_at = t.claude_opens = t.claude_first_at = null;
    t.tts_sent_at = t.voice_out_at = t.reply_in_at = null;
    t.voice_ms = 0;
    this.state = 'user';
  }

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
    this.phone.event({ type: 'turn_end', session: this.sessionId });
    void this.record(this.turn).catch((e) => this.log(`record failed: ${e}`));
    this.turn = this.blank();
    this.state = 'user';
  }

  private blank(): Turn {
    return {
      turn: ++this.turns, mode: this.mode, model: this.model, permission: this.permission, effort: this.effort,
      session_id: null, heard: '', clip: null, proposed: '', corrected: null, instruction: '',
      approval: null, said: '', speech_end_at: null, partial_first_at: null, partial_last_at: null, heard_at: null, corrected_at: null,
      ran_at: null, claude_start_at: null, claude_opens: null, claude_first_at: null, tts_sent_at: null,
      voice_out_at: null, reply_in_at: null, voice_ms: 0, heard_ms: null, cost_usd: null,
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
    // What the turn cost, beside what it took — the two numbers a model or a prompt
    // change moves, and the reason this one is a turn's own cost rather than the
    // session's running total (see claude.ts).
    const cost = t.cost_usd === null ? '' : `  $${t.cost_usd.toFixed(4)}`;
    // What the listener actually heard, said only when it is not what was sent — a
    // reply cut short by a route change, or dropped by a barge-in. The margin is one
    // buffer's worth of rounding between a byte count here and a frame count there.
    // A turn where the two agree adds nothing, so an ordinary line stays the line it
    // has always been and this one is only ever bad news.
    const heard = t.heard_ms !== null && t.voice_ms - t.heard_ms > 250 ? ` (${(t.heard_ms / 1000).toFixed(1)}s heard)` : '';
    this.log(
      `turn ${t.turn} end  stt ${d(t.speech_end_at, t.heard_at)}  final ${d(t.partial_last_at, t.heard_at)}  ${corrected}${held}` +
      `${claude}  buffer ${d(t.claude_first_at, t.tts_sent_at)}  tts ${d(t.tts_sent_at, t.voice_out_at)}  ` +
      `→phone ${d(t.voice_out_at, t.reply_in_at)}  ${(t.voice_ms / 1000).toFixed(1)}s voice${heard}${cost}`,
    );
    await append(t);
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
