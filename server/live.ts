/**
 * Which chats Claude is working in right now.
 *
 * The session store on disk cannot say this — a transcript mid-turn and a finished
 * one look the same — so it is the one fact about a chat that only this process
 * knows. Every Claude session claude.ts opens reports here: which chat it turned
 * out to be, and whether work is in flight — a turn being answered, or a background
 * task still going after the phone hung up. server.ts merges the answer into the
 * chat list and pushes a fresh list to every data connection the moment it changes,
 * which is what draws and clears the pill on the phone.
 *
 * A report per session rather than a flag per chat id, for two reasons: a fresh
 * chat has no id until Claude's first frame names it, and two connections may
 * resume the same chat — a chat is working while any session in it says so, and a
 * session that dies takes only its own report with it.
 */

export interface Live {
  /** What this session is now: which chat, and whether work is in flight. */
  update(id: string | null, busy: boolean): void;
  /** The session is gone, taking its report with it. */
  close(): void;
}

const reports = new Map<Live, { id: string | null; busy: boolean }>();
const watchers = new Set<() => void>();
let last = new Set<string>();

/** The chats with work in flight, by session id. */
export function working(): Set<string> {
  const out = new Set<string>();
  for (const r of reports.values()) if (r.busy && r.id) out.add(r.id);
  return out;
}

/** Say when the set of working chats changes. Returns the way to stop being told. */
export function watch(fn: () => void): () => void {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

/** A new session's report, blank until it says otherwise. */
export function track(): Live {
  const live: Live = {
    update(id, busy) {
      reports.set(live, { id, busy });
      changed();
    },
    close() {
      reports.delete(live);
      changed();
    },
  };
  reports.set(live, { id: null, busy: false });
  return live;
}

/** Tell the watchers — but only when the answer they read actually moved. */
function changed(): void {
  const now = working();
  if (now.size === last.size && [...now].every((id) => last.has(id))) return;
  last = now;
  for (const fn of watchers) fn();
}
