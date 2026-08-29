/**
 * Bring a conversation you had somewhere else into this project, whole: every turn a
 * message of its own, so it opens in the drawer the way it happened, resumes by voice
 * with all of it as context, and can be forked from any answer in it.
 *
 * This writes a Claude Code transcript rather than asking the SDK to make one, and
 * that deserves saying plainly. There is no API for putting a past conversation into a
 * session: `query` gives you one turn per model reply, so 234 turns means 234 replies
 * nobody wanted, and `shouldQuery: false` — which sounds like the answer — merges its
 * messages into the next one that queries, so 34 pieces went in and 3 came out. One
 * giant message is the only thing the SDK will take, and a phone draws nothing at all
 * for 160KB of text: the chat opens blank.
 *
 * So the entries are written here, and then checked rather than trusted — see the
 * verification at the bottom of this file's docs. The format is small: entries chain
 * by `parentUuid`, alternate user and assistant, and carry the session's own id.
 *
 * Input is JSON — `{ name, turns: [{ role: "user" | "model", at, text }] }`.
 * Deliberately not HTML: a saved claude.ai page holds only the messages that were
 * scrolled into view (measured: 8 of 234), and a conversation with edited messages is
 * a tree, so "the conversation" is one path through it and a page save cannot say
 * which. Fetch the path from the source and hand it here.
 *
 *   node import.ts ~/Downloads/emergence-path.json
 *   node chats.ts <id>                     every turn should be there
 *   PROBE_URL='ws://localhost:8765?resume=<id>' node probe.ts "..."   and be remembered
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renameSession } from '@anthropic-ai/claude-agent-sdk';

interface Turn {
  role: 'user' | 'model';
  at?: string;
  text: string;
}

interface Conversation {
  name?: string;
  turns: Turn[];
}

const CWD = (process.env['PROJECT_CWD'] ?? fileURLToPath(new URL('..', import.meta.url))).replace(/\/+$/, '');

/** Claude Code names a project's directory after its path, with everything else dashed out. */
function projectDir(): string {
  return join(homedir(), '.claude', 'projects', CWD.replace(/[^a-zA-Z0-9-]/g, '-'));
}

/**
 * Write the conversation as a session, and return its id.
 *
 * The first message carries the framing — that this is history and not a list of
 * orders — because a resumed session is read from the top, and without it the whole
 * transcript reads as instructions.
 */
export function importConversation(conversation: Conversation): string {
  const turns = conversation.turns.filter((t) => t.text?.trim());
  if (!turns.length) throw new Error('no turns to import');

  const sessionId = randomUUID();
  const lines: string[] = [];
  let parentUuid: string | null = null;

  const from = turns[0]?.at?.slice(0, 10);
  const to = turns[turns.length - 1]?.at?.slice(0, 10);
  const preface = `This is a conversation the two of us already had, elsewhere${
    from && to ? ` between ${from} and ${to}` : ''
  }. What follows is our shared history, not a list of things to do now. Read it as ours, and carry on from where it stops.`;

  const write = (turn: Turn) => {
    const uuid = randomUUID();
    const timestamp = turn.at ?? new Date().toISOString();
    const common = { parentUuid, isSidechain: false, uuid, timestamp, cwd: CWD, sessionId, userType: 'external' };
    lines.push(JSON.stringify(
      turn.role === 'user'
        ? { ...common, type: 'user', message: { role: 'user', content: turn.text } }
        : { ...common, type: 'assistant', message: { role: 'assistant', type: 'message', content: [{ type: 'text', text: turn.text }] } },
    ));
    parentUuid = uuid;
  };

  write({ role: 'user', at: turns[0]!.at, text: preface });
  for (const turn of turns) write(turn);

  mkdirSync(projectDir(), { recursive: true });
  writeFileSync(join(projectDir(), `${sessionId}.jsonl`), `${lines.join('\n')}\n`);
  return sessionId;
}

// --- CLI: run alone ---------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node import.ts <conversation.json>'); process.exit(1); }
  const conversation = JSON.parse(readFileSync(file.replace(/^~/, process.env['HOME'] ?? '~'), 'utf8')) as Conversation;
  const id = importConversation(conversation);
  // A chat is found by its name in the drawer, so give it the one it already had.
  if (conversation.name) await renameSession(id, conversation.name, { dir: CWD });
  console.error(`${conversation.turns.length} turns`);
  console.log(id);
  process.exit(0);
}
