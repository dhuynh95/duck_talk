// @ts-check
// What has been said and what is being said, as a reducer over the relay's text frames: the
// half of `VoiceSession.swift` that is rules rather than plumbing (`handle`, `commit`, `take`,
// `endToolRun`). No socket, no audio, no clock — session.js owns those and applies what
// `handle` returns — so every rule here is a test away.
//
// `utterance` is the sentence being transcribed right now and `lines` is everything already
// sent; an utterance joins `lines` only when the relay shows it ran (`turn_start`, `model`,
// a named `tool`, `turn_end`, or an approval), so nothing appears in the history that never
// ran. Nothing here is changed in place: every change makes a new array (and a new line), so
// a subscriber can tell what moved by comparing.

/**
 * A picture or a pasted text waiting for the next instruction. The id is minted by the page
 * (the moment it was picked), because it has to exist before any socket does.
 * @typedef {{ id: number, data: string } | { id: number, text: string }} Attachment
 */

/**
 * One thing a line was given with: a picture this page has in hand (just sent, so `data`), a
 * picture the relay keeps (read back from a stored chat, so only its `id`), or a pasted text.
 * A paste just sent keeps its `id`, so a retract can hand it back under the same name.
 * @typedef {{ type: 'image', id: number, data?: string } | { type: 'text', text: string, id?: number }} Piece
 */

/**
 * One entry in the transcript: what you said, what Claude said, or the run of tools between.
 * `uuid` is where the line sits in the stored chat and `after` is where a fork has to cut to
 * replace it — set for a loaded line, and for a line just said once `turn_end` names it.
 * `clip` is the audio a spoken line was heard from.
 * @typedef {{
 *   id: number,
 *   kind: 'user' | 'model' | 'tools',
 *   text: string,
 *   tools: string[],
 *   running: boolean,
 *   uuid?: string,
 *   after?: string,
 *   clip?: number,
 *   given: Piece[],
 * }} Line
 */

/**
 * One message of a stored chat, as `chat_open` returns it.
 * @typedef {{ uuid: string, after?: string, role: 'user' | 'model', text: string, clip?: number, images?: number[], pastes?: string[] }} ChatMessage
 */

/**
 * @typedef {{
 *   lines: Line[],
 *   utterance: string | null,
 *   heardClip: number | null,
 *   pending: string | null,
 *   inFlight: boolean,
 *   chatId: string | null,
 *   error: string | null,
 *   attached: Attachment[],
 * }} TranscriptState
 */

/**
 * What the audio should do about a frame: `waiting` is whether a reply is owed (the chimes'
 * cue), `flush` drops what the speaker holds, `expectReply` restarts the played count.
 * @typedef {{ waiting?: boolean, flush?: boolean, expectReply?: boolean }} Effects
 */

/** Line ids, unique for the page's life — a chat shown twice still draws new rows. */
let lastLineId = 0;

/**
 * @param {Line['kind']} kind
 * @param {Partial<Omit<Line, 'id' | 'kind'>>} [rest]
 * @returns {Line}
 */
function line(kind, rest = {}) {
  return { id: ++lastLineId, kind, text: '', tools: [], running: false, given: [], ...rest };
}

/** @param {Attachment} a @returns {Piece} */
function pieceOf(a) {
  return 'data' in a ? { type: 'image', id: a.id, data: a.data } : { type: 'text', id: a.id, text: a.text };
}

/** A piece back in hand, for a retract; none for a picture only the relay has. @param {Piece} p @returns {Attachment | null} */
function attachmentOf(p) {
  if (p.type === 'image') return p.data !== undefined ? { id: p.id, data: p.data } : null;
  return p.id !== undefined ? { id: p.id, text: p.text } : null;
}

/** @param {ChatMessage} m @returns {Line} */
function lineOf(m) {
  /** @type {Piece[]} */
  const given = [
    ...(m.images ?? []).map((id) => /** @type {Piece} */ ({ type: 'image', id })),
    ...(m.pastes ?? []).map((text) => /** @type {Piece} */ ({ type: 'text', text })),
  ];
  /** @type {Partial<Line>} */
  const rest = { text: m.text, uuid: m.uuid, given };
  if (m.after !== undefined) rest.after = m.after;
  if (m.clip !== undefined) rest.clip = m.clip;
  return line(m.role === 'user' ? 'user' : 'model', rest);
}

/** @param {unknown} v */
const str = (v) => (typeof v === 'string' ? v : undefined);

/** `{uuid, after?}` on a `turn_end`, or nothing. @param {unknown} v */
function saved(v) {
  if (typeof v !== 'object' || v === null) return undefined;
  const uuid = str(/** @type {{ uuid?: unknown }} */ (v).uuid);
  if (uuid === undefined) return undefined;
  return { uuid, after: str(/** @type {{ after?: unknown }} */ (v).after) };
}

export class Transcript {
  /** @type {TranscriptState} */
  state = {
    lines: [],
    utterance: null,
    heardClip: null,
    pending: null,
    inFlight: false,
    chatId: null,
    error: null,
    attached: [],
  };

  /** Whatever text comes next starts its own line — set at a turn's edges. */
  #turnEnded = false;
  /** This turn has already put lines in the history: what a retract may undo, and all it may undo. */
  #committed = false;

  /** @param {Partial<TranscriptState>} patch */
  #set(patch) {
    this.state = { ...this.state, ...patch };
  }

  /** @param {(l: Line) => Line} change */
  #changeLast(change) {
    const { lines } = this.state;
    const last = lines.at(-1);
    if (last) this.#set({ lines: lines.with(-1, change(last)) });
  }

  /**
   * The pending pieces, handed to the line being committed — moved, not copied, so the
   * composer empties the way it does for the words.
   */
  #take() {
    const given = this.state.attached.map(pieceOf);
    this.#set({ attached: [] });
    return given;
  }

  /**
   * Move what was said into the history, now that it has actually been sent — with the audio
   * it was heard from, which is what makes the line correctable later.
   * @param {string} [text] the words as approved, in place of the utterance
   */
  #commit(text) {
    const said = (text ?? this.state.utterance)?.trim();
    const clip = this.state.heardClip;
    this.#set({ utterance: null, heardClip: null });
    if (!said) return;
    /** @type {Partial<Line>} */
    const rest = { text: said, given: this.#take() };
    if (clip !== null) rest.clip = clip;
    this.#set({ lines: [...this.state.lines, line('user', rest)] });
    this.#committed = true;
  }

  /** The tools stop running when speech resumes or the turn ends. */
  #endToolRun() {
    if (this.state.lines.at(-1)?.kind === 'tools') this.#changeLast((l) => ({ ...l, running: false }));
  }

  /**
   * Type an instruction. Nothing has to prove it was sent — you wrote it — so it is history at
   * once. `given` goes on the line ahead of the pending pieces. False when there are no words.
   * @param {string} text
   * @param {Piece[]} [given]
   */
  sendTyped(text, given = []) {
    const said = text.trim();
    if (!said) return false;
    this.#set({ lines: [...this.state.lines, line('user', { text: said, given: [...given, ...this.#take()] })], inFlight: true });
    return true;
  }

  /**
   * Run the held instruction as edited: accepting is what sends it, so that is when it becomes
   * history. False when nothing is held.
   * @param {string} text
   */
  approve(text) {
    if (this.state.pending === null) return false;
    this.#set({ pending: null });
    this.#commit(text);
    return true;
  }

  /**
   * Put a stored conversation on screen without starting a turn — or clear for a new one.
   * @param {ChatMessage[]} past
   * @param {string | null} id
   */
  show(past, id) {
    this.state = {
      lines: past.map(lineOf),
      utterance: null,
      heardClip: null,
      pending: null,
      inFlight: false,
      chatId: id,
      error: null,
      attached: [], // picked for the conversation you were in, not this one
    };
    this.#turnEnded = false;
    this.#committed = false;
  }

  /** What a closed socket leaves unsaid: held, being said, or heard — none of it carries over. */
  forget() {
    this.#set({ pending: null, utterance: null, heardClip: null });
  }

  /** Something went wrong that the screen should say, or nothing now. @param {string | null} message */
  setError(message) {
    this.#set({ error: message });
  }

  /** @param {Attachment} item */
  attach(item) {
    this.#set({ attached: [...this.state.attached, item] });
  }

  /** Take one back before it has been sent. @param {number} id */
  drop(id) {
    this.#set({ attached: this.state.attached.filter((a) => a.id !== id) });
  }

  /**
   * One text frame from the relay, already parsed. Anything that is not an event it knows is
   * ignored. Returns what the audio should do about it.
   * @param {unknown} event
   * @returns {Effects}
   */
  handle(event) {
    if (typeof event !== 'object' || event === null) return {};
    const e = /** @type {Record<string, unknown>} */ (event);
    const text = str(e['text']);
    const session = str(e['session']);

    switch (e['type']) {
      case 'user':
        // The whole utterance so far, revised as it is spoken: it replaces rather than
        // extends, and stays out of the history until it is sent.
        this.#set({ utterance: text ?? null });
        this.#turnEnded = false;
        if (e['partial'] !== true) this.#set({ heardClip: typeof e['clip'] === 'number' ? e['clip'] : null });
        return {};

      case 'turn_start':
        // The chat now has a name, so every socket after this one carries it.
        if (session !== undefined) this.#set({ chatId: session });
        this.#set({ inFlight: true });
        this.#commit();
        // On a turn joined mid-way the last line is a block the transcript already holds
        // complete, so whatever text comes next starts its own.
        this.#turnEnded = true;
        return { waiting: true, expectReply: true };

      case 'model': {
        this.#commit(); // Claude answering is proof the instruction went
        const last = this.state.lines.at(-1);
        if (!this.#turnEnded && last?.kind === 'model') {
          this.#changeLast((l) => ({ ...l, text: l.text + (text ?? '') }));
        } else {
          this.#turnEnded = false;
          this.#set({ lines: [...this.state.lines, line('model', { text: text ?? '' })] });
        }
        return { waiting: true };
      }

      case 'approval':
        // Held for a decision: the box stops being a transcript and becomes a question.
        this.#set({ utterance: null, pending: text ?? null });
        return {};

      case 'tool':
        // A name starts a tool, no name ends it. Consecutive tools join one line, and a
        // subagent's tools join the Agent's line.
        if (text !== undefined) {
          this.#commit();
          this.#turnEnded = false;
          if (this.state.lines.at(-1)?.kind === 'tools') {
            this.#changeLast((l) => ({ ...l, tools: [...l.tools, text], running: true }));
          } else {
            this.#set({ lines: [...this.state.lines, line('tools', { tools: [text], running: true })] });
          }
          return { waiting: true };
        }
        // A subagent finishing a tool says nothing about the Agent that started it.
        if (e['parent'] === undefined || e['parent'] === null) this.#endToolRun();
        return {};

      case 'turn_end': {
        this.#commit(); // a turn that answered nothing still ran
        this.#committed = false;
        this.#turnEnded = true;
        this.#set({ pending: null, inFlight: false });
        if (session !== undefined) this.#set({ chatId: session });
        // The turn's two messages have a place in the store now: Edit on yours, Fork on Claude's.
        const user = saved(e['user']);
        const model = saved(e['model']);
        let lines = this.state.lines;
        const u = lines.findLastIndex((l) => l.kind === 'user');
        if (user && u >= 0) {
          /** @type {Line} */
          const l = { .../** @type {Line} */ (lines[u]), uuid: user.uuid };
          if (user.after !== undefined) l.after = user.after;
          else delete l.after;
          lines = lines.with(u, l);
        }
        const m = lines.findLastIndex((l) => l.kind === 'model');
        if (model && m >= 0) lines = lines.with(m, { .../** @type {Line} */ (lines[m]), uuid: model.uuid });
        this.#set({ lines });
        this.#endToolRun();
        return { waiting: false };
      }

      case 'interrupted':
        // Sent whenever a held instruction is decided, and on a barge-in.
        this.#set({ pending: null });
        // A retract: you are still speaking the instruction, and what Claude said to the
        // fragment must not sit beside the real answer. Only what this turn committed comes off.
        if (e['retract'] === true && this.#committed) {
          const lines = this.state.lines;
          const u = lines.findLastIndex((l) => l.kind === 'user');
          const taken = lines[u];
          // The pieces come back to the composer under the same ids: the relay still holds
          // them for the re-run, so none is sent again on this socket.
          const back = (taken?.given ?? []).map(attachmentOf).filter((a) => a !== null);
          this.#set({ lines: lines.slice(0, Math.max(u, 0)), attached: [...back, ...this.state.attached] });
          this.#committed = false;
        }
        this.#endToolRun();
        return { waiting: false, flush: true };

      case 'error':
        this.#set({ error: text ?? null });
        return {};

      default:
        return {};
    }
  }
}
