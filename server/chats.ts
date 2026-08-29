/**
 * The conversations you have had with Claude Code in this project: list them, read
 * one back, and branch off any answer in one.
 *
 * All three are the SDK's own session management, pointed at the same directory the
 * relay runs Claude in. Nothing here parses a transcript. That matters beyond tidiness
 * — the store these read is the store `?resume=` replays, so a chat in the list is a
 * chat that can be resumed, and a fork is resumable the moment it exists. It also
 * means every session you started in a terminal is here: begin at the desk, carry on
 * from your pocket.
 *
 * Forking is what makes a mishearing recoverable. A voice session can talk itself into
 * a corner — the mic hears the reply, the reply becomes the next instruction — and
 * cutting back to the last good answer beats arguing with the echo.
 *
 *   node chats.ts                    list them
 *   node chats.ts <id>               print it, with the uuid of each message
 *   node chats.ts fork <id> <uuid>   branch at that message, print the new id
 */

import { fileURLToPath } from 'node:url';
import { forkSession, getSessionMessages, listSessions, type SessionMessage } from '@anthropic-ai/claude-agent-sdk';

/** One exchange, as it would be spoken. `uuid` is where a fork can cut. */
export interface Message {
  uuid: string;
  role: 'user' | 'model';
  text: string;
}

export interface Chat {
  /** The session id — what `?resume=` takes, so opening a chat is enough to continue it. */
  id: string;
  /** Last written, which is what "when did I last talk about this" means. */
  at: number;
  title: string;
}

// The directory claude.ts runs in, which is what scopes a session to this project.
// Without the trailing slash a directory URL leaves behind.
const CWD = (process.env['PROJECT_CWD'] ?? fileURLToPath(new URL('..', import.meta.url))).replace(/\/+$/, '');
const LIST = 50; // a phone list, not an archive

/** Every chat in this project, most recently touched first. */
export async function chats(): Promise<Chat[]> {
  const sessions = await listSessions({ dir: CWD, limit: LIST });
  return sessions
    .map((s) => ({ id: s.sessionId, at: s.lastModified, title: s.summary.slice(0, 120) }))
    .filter((c) => c.title);
}

/** One chat, whole, in the order it happened. */
export async function chat(id: string): Promise<Message[]> {
  const messages = await getSessionMessages(id, { dir: CWD });
  const all: Message[] = [];
  for (const m of messages) {
    if (m.type !== 'user' && m.type !== 'assistant') continue;
    const said = text(m);
    // An assistant turn that only called tools has no words in it, and a phone shows
    // speech.
    if (said) all.push({ uuid: m.uuid, role: m.type === 'user' ? 'user' : 'model', text: said });
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
  const [first, ...rest] = process.argv.slice(2);
  if (first === 'fork') {
    const [id, uuid] = rest;
    if (!id || !uuid) { console.error('usage: node chats.ts fork <id> <uuid>'); process.exit(1); }
    console.log(await fork(id, uuid));
  } else if (first) {
    const messages = await chat(first);
    console.error(`${messages.length} messages`);
    for (const m of messages) {
      console.log(`${m.uuid}  ${m.role === 'user' ? '›' : ' '} ${m.text.slice(0, 120)}`);
    }
  } else {
    const all = await chats();
    console.log(`${all.length} chats in ${CWD}`);
    for (const c of all) console.log(`${new Date(c.at).toISOString().slice(0, 16)}  ${c.id.slice(0, 8)}  ${c.title}`);
  }
}
