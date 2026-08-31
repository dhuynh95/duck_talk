/**
 * The conversations you have had with Claude Code in this project: list them, read one
 * back, branch off any answer, and — star, rename, delete.
 *
 * Every one of those is the SDK's own session management, pointed at the same directory
 * the relay runs Claude in. Nothing here parses a transcript and nothing here keeps a
 * file of its own; `dir` is the whole address, and where the sessions actually sit on
 * disk is the SDK's business, not ours. That matters beyond tidiness — the store these
 * read is the store `?resume=` replays, so a chat in the list is a chat that can be
 * resumed, and a fork is resumable the moment it exists. It also means every session you
 * started in a terminal is here, with the title you gave it there: begin at the desk,
 * carry on from your pocket.
 *
 * A star is that store's own session tag, for the same reason. A list of starred ids
 * kept beside it would be a second index to keep in step — one that outlives a deleted
 * chat and can disagree with the terminal about what is flagged.
 *
 * Forking is what makes a mishearing recoverable. A voice session can talk itself into
 * a corner — the mic hears the reply, the reply becomes the next instruction — and
 * cutting back to the last good answer beats arguing with the echo.
 *
 *   node chats.ts                      list them
 *   node chats.ts <id>                 print it, with the uuid of each message
 *   node chats.ts fork <id> <uuid>     branch at that message, print the new id
 *   node chats.ts star <id> [off]      keep it at the top of the list
 *   node chats.ts rename <id> <title>  give it a name of your own
 *   node chats.ts delete <id>          for good, transcript included
 */

import { fileURLToPath } from 'node:url';
import { deleteSession, forkSession, getSessionMessages, listSessions, renameSession, tagSession, type SessionMessage } from '@anthropic-ai/claude-agent-sdk';
// The directory claude.ts runs in, which is what scopes a session to this project.
import { PROJECT as CWD } from './paths.ts';
import { clips } from './turns.ts';

/** One exchange, as it would be spoken. `uuid` is where a fork can cut. */
export interface Message {
  uuid: string;
  role: 'user' | 'model';
  text: string;
  /** The audio this was heard from, when it was spoken and the clip is still kept.
   *  Only the id travels — the phone asks for the sound when someone presses play. */
  clip?: number;
}

export interface Chat {
  /** The session id — what `?resume=` takes, so opening a chat is enough to continue it. */
  id: string;
  /** Last written, which is what "when did I last talk about this" means. */
  at: number;
  title: string;
  /** Tagged, which is what the phone draws as a star and lists first. */
  starred: boolean;
}

// Long enough that a chat starred last week is still in it. A star has to keep a chat
// reachable, and a morning of talking is enough to push one past fifty.
const LIST = 200;

/** Every chat in this project: starred first, then most recently touched. */
export async function chats(): Promise<Chat[]> {
  const sessions = await listSessions({ dir: CWD, limit: LIST });
  return sessions
    .map((s) => ({ id: s.sessionId, at: s.lastModified, title: s.summary.slice(0, 120), starred: Boolean(s.tag) }))
    .filter((c) => c.title)
    // Stable, so recency survives inside each group and there is one sort, not two.
    .sort((a, b) => Number(b.starred) - Number(a.starred));
}

/**
 * One chat, whole, in the order it happened — with the audio each spoken line was
 * heard from, where the relay still has it.
 *
 * The turn log is what makes that possible and it needed nothing added to it: it
 * already records the instruction Claude was sent beside the clip it came from, and
 * the instruction is verbatim what the transcript shows. So a conversation you had
 * last week can be listened to and corrected, and there is no second index to keep in
 * step with this one.
 */
export async function chat(id: string): Promise<Message[]> {
  const messages = await getSessionMessages(id, { dir: CWD });
  const heard = clips();
  const all: Message[] = [];
  for (const m of messages) {
    if (m.type !== 'user' && m.type !== 'assistant') continue;
    const said = text(m);
    // An assistant turn that only called tools has no words in it, and a phone shows
    // speech.
    if (!said) continue;
    const role = m.type === 'user' ? 'user' : 'model';
    const clip = role === 'user' ? heard.get(said) : undefined;
    all.push({ uuid: m.uuid, role, text: said, ...(clip ? { clip } : {}) });
  }
  return all;
}

/**
 * Branch a chat at one message: a new conversation holding everything up to and
 * including it, and nothing after.
 *
 * `upToMessageId` wants the whole uuid — a prefix is rejected — which is why `chat()`
 * hands the full one out and the phone sends back exactly what it was given.
 */
export async function fork(id: string, uuid: string): Promise<string> {
  const { sessionId } = await forkSession(id, { dir: CWD, upToMessageId: uuid });
  return sessionId;
}

/**
 * Keep a chat at the top of the list, or stop. The tag is the star — see above.
 *
 * A session has one tag, and this spends it. Any tag counts as a star, which is the
 * forgiving way round: a chat tagged something else from elsewhere shows up flagged and
 * an explicit Unstar clears it, where matching on the word alone would leave that tag
 * invisible for a Star to overwrite without asking.
 */
export async function star(id: string, on: boolean): Promise<void> {
  await tagSession(id, on ? 'starred' : null, { dir: CWD });
}

/** A title of your own, in place of the summary Claude Code wrote. */
export async function rename(id: string, title: string): Promise<void> {
  await renameSession(id, title, { dir: CWD });
}

/** For good, transcript included — so `?resume=` on it will fail from here on. */
export async function remove(id: string): Promise<void> {
  await deleteSession(id, { dir: CWD });
}

/** The words in a message, without the tool calls and the thinking. */
function text(m: SessionMessage): string {
  const content = (m.message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content as { type?: string; text?: unknown }[]) {
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push(b.text.trim());
  }
  return parts.join('\n\n');
}

// --- CLI: run alone ---------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [first, id, ...words] = process.argv.slice(2);
  if (first === 'fork') {
    if (!id || !words[0]) { console.error('usage: node chats.ts fork <id> <uuid>'); process.exit(1); }
    console.log(await fork(id, words[0]));
  } else if (first === 'star' && id) {
    await star(id, words[0] !== 'off');
  } else if (first === 'rename' && id && words.length) {
    await rename(id, words.join(' '));
  } else if (first === 'delete' && id) {
    await remove(id);
  } else if (first) {
    const messages = await chat(first);
    console.error(`${messages.length} messages`);
    for (const m of messages) {
      console.log(`${m.uuid}  ${m.clip ? '♪' : ' '}${m.role === 'user' ? '›' : ' '} ${m.text.slice(0, 120)}`);
    }
  } else {
    const all = await chats();
    console.log(`${all.length} chats in ${CWD}`);
    // The whole id, because the verbs above take one.
    for (const c of all) console.log(`${new Date(c.at).toISOString().slice(0, 16)}  ${c.id} ${c.starred ? '★' : ' '} ${c.title}`);
  }
}
