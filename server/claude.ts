/**
 * Claude Code as one long-lived session per phone connection. Instructions go in
 * through `send`, text and tool blocks come back through callbacks, and a `result`
 * ends each turn. The session stays warm between turns — the first turn pays the
 * ~3s startup, every turn after is ~1s to first token — and `interrupt` stops the
 * current turn without tearing the session down, which is what barge-in needs.
 *
 * Lifted from src/server/claude-client.ts, but stateful: the web backend spawned a
 * fresh subprocess per turn (via `resume`); this keeps one streaming query alive.
 *
 *   node claude.ts "what is the latest commit"     one turn, streamed to stdout
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { query, type Options, type PermissionMode, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

const PROMPT = readFileSync(new URL('./prompts/claude.md', import.meta.url), 'utf8');
const CWD = process.env['PROJECT_CWD'] ?? fileURLToPath(new URL('..', import.meta.url));
const MODEL = process.env['CLAUDE_MODEL'];
const PERMISSION_MODE = (process.env['CLAUDE_PERMISSION_MODE'] ?? 'plan') as PermissionMode;

export type Block =
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export interface Claude {
  /** Start a turn. Only one runs at a time; call after the previous ended or was interrupted. */
  send(instruction: string): void;
  /** Stop the current turn. The session stays warm for the next `send`. */
  interrupt(): void;
  close(): void;
}

export interface ClaudeCallbacks {
  /**
   * A past session to carry on instead of starting a new one. Claude Code keeps the
   * transcript, so this is the whole of resuming: the same warm-session machinery
   * runs, it just starts already knowing what was said. All sessions share one `cwd`,
   * so any id this relay recorded can be resumed.
   */
  resume?: string;
  onText(text: string): void;
  onBlock(block: Block): void;
  onResult(r: { sessionId: string; costUsd: number | null; error: string | null }): void;
  log?(m: string): void;
}

/** The subprocess must not think it is nested inside this Claude Code session. */
function subprocessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (k !== 'CLAUDECODE' && v !== undefined) env[k] = v;
  // Billing: an empty ANTHROPIC_API_KEY (inherited, blank) must not be mistaken for a
  // real one. Drop it unless it holds an actual key, so `claude` authenticates with
  // the logged-in subscription. A real key here is a deliberate choice to bill the API.
  if (!env['ANTHROPIC_API_KEY']?.trim()) delete env['ANTHROPIC_API_KEY'];
  return env;
}

/** Say once, at startup, which account pays for turns — so it is never a guess. */
export function billingMode(): string {
  return process.env['ANTHROPIC_API_KEY']?.trim()
    ? 'ANTHROPIC_API_KEY set → billing the API'
    : 'no ANTHROPIC_API_KEY → billing the logged-in Claude subscription';
}

export function openClaude(cb: ClaudeCallbacks): Claude {
  const log = cb.log ?? (() => {});

  // The input side: `send` drops an instruction in the queue and wakes the generator
  // the SDK is reading. One message per turn — the caller never queues two.
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  // Turn bookkeeping so an interrupted turn's stragglers never reach the next turn.
  // The SDK is sequential: an interrupted turn still ends with its own `result`
  // before the next turn's output, so we swallow everything up to and including the
  // result of any turn at or below `cancelledUpTo`. `finished` counts results seen.
  let sent = 0;
  let finished = 0;
  let cancelledUpTo = 0;
  async function* input(): AsyncGenerator<SDKUserMessage> {
    while (!done) {
      while (queue.length) {
        yield { type: 'user', message: { role: 'user', content: queue.shift()! }, parent_tool_use_id: null };
      }
      if (done) break;
      await new Promise<void>((r) => { wake = r; });
    }
  }

  const options: Options = {
    cwd: CWD,
    systemPrompt: PROMPT,
    includePartialMessages: true,
    permissionMode: PERMISSION_MODE,
    allowedTools: ['Read', 'WebSearch'],
    disallowedTools: ['AskUserQuestion', 'Skill'],
    env: subprocessEnv(),
    stderr: (line: string) => { if (process.env['DEBUG']) console.debug('sdk:', line.trimEnd()); },
  };
  if (MODEL) options.model = MODEL;
  if (cb.resume) { options.resume = cb.resume; log(`resuming ${cb.resume}`); }

  const q: Query = query({ prompt: input(), options });

  // The output side: one loop for the life of the session, routing each turn's
  // messages to the callbacks. `result` marks the end of a turn.
  void (async () => {
    try {
      for await (const msg of q) {
        const alive = finished + 1 > cancelledUpTo; // is the turn now streaming still wanted?
        if (msg.type === 'stream_event') {
          if (!alive) continue;
          const delta = (msg.event as { delta?: { text?: unknown } }).delta;
          if (typeof delta?.text === 'string' && delta.text) cb.onText(delta.text);
        } else if (msg.type === 'assistant') {
          if (!alive) continue;
          for (const b of msg.message.content as { type: string; id?: string; name?: string; input?: unknown }[]) {
            if (b.type === 'tool_use') cb.onBlock({ type: 'tool_use', id: b.id!, name: b.name!, input: b.input });
          }
        } else if (msg.type === 'user') {
          if (!alive) continue;
          const content = msg.message.content;
          if (!Array.isArray(content)) continue;
          for (const b of content as { type: string; tool_use_id?: string; content?: unknown }[]) {
            if (b.type === 'tool_result') {
              cb.onBlock({ type: 'tool_result', tool_use_id: b.tool_use_id!, content: typeof b.content === 'string' ? b.content : b.content ? String(b.content) : '' });
            }
          }
        } else if (msg.type === 'result') {
          finished++; // this turn is over, wanted or not
          if (!alive) continue; // an interrupted turn's result is swallowed with its output
          let error: string | null = null;
          if (msg.is_error) error = 'errors' in msg && Array.isArray(msg.errors) ? msg.errors.join('; ') : 'result' in msg ? String(msg.result) : 'unknown error';
          cb.onResult({ sessionId: msg.session_id, costUsd: msg.total_cost_usd, error });
        }
      }
    } catch (e) {
      if (!done) log(`claude stream ended: ${e}`);
    }
  })();

  return {
    send(instruction) {
      sent++;
      queue.push(instruction);
      wake?.();
      wake = null;
    },
    interrupt() {
      // Turn-level: stops the running turn, session stays alive for the next send.
      // Fence its stragglers — every turn sent so far is now unwanted.
      cancelledUpTo = sent;
      void q.interrupt().catch((e) => log(`claude interrupt: ${e}`));
    },
    close() {
      done = true;
      wake?.();
      wake = null;
    },
  };
}

// --- CLI: run alone ---------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const instruction = process.argv.slice(2).join(' ');
  if (!instruction) { console.error('usage: node claude.ts "instruction"'); process.exit(1); }
  const t0 = performance.now();
  let first = 0;
  const claude = openClaude({
    log: console.error,
    onText: (t) => { if (!first) first = Math.round(performance.now() - t0); process.stdout.write(t); },
    onBlock: (b) => process.stderr.write(`\n[${b.type === 'tool_use' ? b.name : 'result'}]\n`),
    onResult: (r) => {
      console.log(`\n\nfirst token ${first}ms, $${r.costUsd}, session ${r.sessionId}${r.error ? `, error: ${r.error}` : ''}`);
      claude.close();
      process.exit(0);
    },
  });
  claude.send(instruction);
}
