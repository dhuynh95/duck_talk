/**
 * Claude Code as one long-lived session per phone connection. Instructions go in
 * through `send`, text and tool blocks come back through callbacks, and a `result`
 * ends each turn. The session stays warm between turns — the first turn pays the
 * ~3s startup, every turn after is ~1s to first token — and `interrupt` stops the
 * current turn without tearing the session down, which is what barge-in needs. That
 * warmth is why the `claude` prompt is read once here and not per turn.
 *
 * Lifted from the web app's claude-client.ts (the `web-app` tag), but stateful: that
 * backend spawned a fresh subprocess per turn via `resume`, where this keeps one
 * streaming query alive.
 *
 *   node claude.ts "what is the latest commit"     one turn, streamed to stdout
 */

import { fileURLToPath } from 'node:url';
import { query, type AccountInfo, type Options, type PermissionMode, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { PROJECT as CWD } from './paths.ts';
import { read } from './prompts.ts';

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
  /**
   * Claude opened its first block of this turn, and what kind: `text` means it is
   * answering, `thinking` or `tool_use` mean the wait before any words is its own
   * doing rather than the API's. Once per turn.
   */
  onStart?(kind: string): void;
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

/**
 * Which account Claude Code will bill, asked rather than inferred.
 *
 * `accountInfo` is a control request on a streaming query: it starts the CLI, asks who
 * is authenticated, and never sends a prompt — 716ms and nothing billed, against ~4.4s
 * and a real turn for `claude -p`. The presence of an `ANTHROPIC_API_KEY` was only ever
 * a guess at the answer; this is the CLI's own.
 *
 * What it proves is that the binary launches and holds credentials, and no more: an
 * account that is rate-limited or whose subscription has lapsed still answers cleanly
 * here. Only a turn proves a turn — which is what CI runs, and what the first real
 * instruction finds out anyway.
 */
export async function claudeAccount(): Promise<AccountInfo | null> {
  // A prompt that never yields: the query has to be streaming for a control request,
  // and there is nothing to say.
  const q = query({
    prompt: (async function* (): AsyncGenerator<SDKUserMessage> { await new Promise(() => {}); })(),
    options: { cwd: CWD, env: subprocessEnv() },
  });
  try {
    return await q.accountInfo();
  } catch {
    return null; // no CLI, or one that cannot say who it is — the line below reports it
  } finally {
    q.close();
  }
}

/** That answer as the one line the relay prints at startup. */
export async function billingMode(): Promise<string> {
  const account = await claudeAccount();
  if (!account) return 'could not ask Claude Code who is signed in — is `claude` on PATH?';
  const who = [account.email, account.organization].filter(Boolean).join(' · ');
  const how = process.env['ANTHROPIC_API_KEY']?.trim()
    ? 'billing the API (ANTHROPIC_API_KEY is set)'
    : `billing ${account.subscriptionType ?? account.apiProvider ?? 'the logged-in account'}`;
  return who ? `${who} — ${how}` : how;
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
  let opened = false; // this turn's first block has been announced
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
    // Read here rather than at module load, so an edit made from the phone reaches
    // the next session. It cannot reach this one: the SDK takes the prompt when the
    // query is built, and rebuilding per turn would throw the warm session away.
    systemPrompt: read('claude'),
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
          const event = msg.event as { type?: string; delta?: { text?: unknown }; content_block?: { type?: string } };
          if (!opened && event.type === 'content_block_start') {
            opened = true;
            cb.onStart?.(event.content_block?.type ?? 'unknown');
          }
          if (typeof event.delta?.text === 'string' && event.delta.text) cb.onText(event.delta.text);
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
          opened = false; // the next turn opens its own first block
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
