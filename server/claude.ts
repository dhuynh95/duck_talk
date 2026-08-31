/**
 * Claude Code as one long-lived session per phone connection. Instructions go in
 * through `send`, text and tool blocks come back through callbacks, and a `result`
 * ends each turn. The session stays warm between turns — the first turn pays the
 * ~3s startup, every turn after is ~1s to first token — and `interrupt` stops the
 * current turn without tearing the session down, which is what barge-in needs. That
 * warmth is why the `claude` prompt is read once here and not per turn.
 *
 * Two things about the session are not fixed that way: which model answers and what it
 * is allowed to do. Both are control requests the CLI takes mid-session, so `set` puts
 * them on the running session and they hold from the next turn — which is why they
 * reach here as a message from the phone rather than as something chosen when the
 * socket opened. `capabilities()` is the other side of that: the models this Mac can
 * actually offer, asked of the CLI instead of written down here.
 *
 * Lifted from the web app's claude-client.ts (the `web-app` tag), but stateful: that
 * backend spawned a fresh subprocess per turn via `resume`, where this keeps one
 * streaming query alive.
 *
 *   node claude.ts "what is the latest commit"     one turn, streamed to stdout
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { query, type AccountInfo, type ModelInfo, type Options, type PermissionMode, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { PROJECT as CWD } from './paths.ts';
import { read } from './prompts.ts';

const MODEL = process.env['CLAUDE_MODEL'];
const PERMISSION_MODE = (process.env['CLAUDE_PERMISSION_MODE'] ?? 'plan') as PermissionMode;

/** What a session is until something asks it to be otherwise — the environment's
 *  answer, so the phone and the turn log start from the same place the CLI does. */
export const DEFAULTS: { model: string | null; permission: PermissionMode } = {
  model: MODEL ?? null,
  permission: PERMISSION_MODE,
};

export type { PermissionMode };

export type Block =
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export interface Claude {
  /** Start a turn. Only one runs at a time; call after the previous ended or was interrupted. */
  send(instruction: string): void;
  /**
   * What Claude is: which model answers, and what it is allowed to do.
   *
   * Both take effect on the turn after this one, on the session already running — so
   * neither is decided when the socket opens, and changing your mind costs no restart.
   * Repeating a value it is already set to does nothing.
   */
  set(model?: string, permission?: PermissionMode): void;
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
  /** `costUsd` is what this turn cost, not what the session has — see the subtraction
   *  in the result branch below. Null when the result carried no usable total.
   *  `model` and `permission` are what the session was set to when it answered. */
  onResult(r: { sessionId: string; costUsd: number | null; error: string | null; model: string | null; permission: PermissionMode }): void;
  /** Something went wrong between turns, so no `result` will carry it — a refused
   *  `set`, and nothing else so far. Worth saying on the screen, not just in the log. */
  onError?(text: string): void;
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

/** What this Mac's Claude Code can do, which only it can say. */
export interface Capabilities {
  /** Null when the CLI could not be asked — missing from PATH, or not signed in. */
  account: AccountInfo | null;
  /** Every model this account may use, each with the words to show for it. Empty for
   *  the same reasons `account` is null. */
  models: ModelInfo[];
}

/**
 * Who is signed in, and which models they may use — one question, asked once.
 *
 * `initializationResult` is a control request on a streaming query: it starts the CLI,
 * reads what it says about itself, and never sends a prompt — ~1s and nothing billed,
 * against ~4.4s and a real turn for `claude -p`. It answers both halves at once, which
 * is why there is no separate call for the account: measured, `supportedModels()` and
 * `accountInfo()` after it return in 0ms, because the CLI's first answer is the cache.
 *
 * Memoized for the life of the relay. The set of models does not change while it runs,
 * and the phone asks for it on every data connection — including the one `ClipChip`
 * opens to play a single clip, which must not pay a subprocess.
 *
 * What it proves is that the binary launches and holds credentials, and no more: an
 * account that is rate-limited or whose subscription has lapsed still answers cleanly
 * here. Only a turn proves a turn — which is what CI runs, and what the first real
 * instruction finds out anyway.
 */
export function capabilities(): Promise<Capabilities> {
  return (asked ??= ask());
}

let asked: Promise<Capabilities> | null = null;

async function ask(): Promise<Capabilities> {
  // A prompt that never yields: the query has to be streaming for a control request,
  // and there is nothing to say.
  const q = query({
    prompt: (async function* (): AsyncGenerator<SDKUserMessage> { await new Promise(() => {}); })(),
    options: { cwd: CWD, env: subprocessEnv() },
  });
  try {
    const init = await q.initializationResult();
    return { account: init.account, models: init.models };
  } catch {
    return { account: null, models: [] }; // no CLI, or one that cannot say — reported below
  } finally {
    q.close();
  }
}

/** That answer as the one line the relay prints at startup. */
export async function billingMode(): Promise<string> {
  const { account } = await capabilities();
  if (!account) return 'could not ask Claude Code who is signed in — is `claude` on PATH?';
  const who = [account.email, account.organization].filter(Boolean).join(' · ');
  const how = process.env['ANTHROPIC_API_KEY']?.trim()
    ? 'billing the API (ANTHROPIC_API_KEY is set)'
    : `billing ${account.subscriptionType ?? account.apiProvider ?? 'the logged-in account'}`;
  return who ? `${who} — ${how}` : how;
}

export function openClaude(cb: ClaudeCallbacks): Claude {
  const log = cb.log ?? (() => {});
  /** Said in the log and on the phone: this happened between turns, so no result
   *  will carry it and a silent failure would look like the tap did nothing. */
  const fail = (text: string) => { log(text); cb.onError?.(text); };

  // The input side: `send` drops an instruction in the queue and wakes the generator
  // the SDK is reading. One message per turn — the caller never queues two.
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  // Which send this session is answering, by the uuid minted for it. The CLI echoes
  // that uuid back on a turn's first stream frame and on its result
  // (`user_message_uuid`), so output is matched to the send that caused it rather
  // than counted — and an interrupt simply stops wanting. Whatever still arrives for
  // an abandoned turn matches nothing: its cost is booked below and it goes no
  // further. Counting was the fence here before, and it lost to the one race this
  // relay runs constantly: `interrupt()` is a request racing the next send, and a
  // turn that died on the wrong side of it emitted results the count misfiled — a
  // stray error on the phone for a turn nobody was waiting on, and turn records
  // with impossible negative timings (3 of the first 133).
  let wanted: string | null = null;
  let streaming: string | null = null; // whose frames are arriving now, by the last stamp seen
  let stamps = false; // this CLI stamps frames — proven the first time one arrives
  let opened = false; // this turn's first block has been announced
  // What the session has cost so far, as the last result reported it. A turn's own
  // cost is the difference — see the result branch.
  let spent = 0;
  // What `set` has put the session on. Kept so a frame repeating itself costs nothing,
  // and so a turn record can name the model that answered it: `modelUsage` on the
  // result cannot, because it is cumulative for the session — after a switch it lists
  // every model the session has ever used, not the one that just spoke.
  let model = MODEL;
  let permission = PERMISSION_MODE;
  // What `set` is still applying, if anything. An instruction waits for it below.
  let settled: Promise<unknown> = Promise.resolve();
  async function* input(): AsyncGenerator<SDKUserMessage> {
    while (!done) {
      while (queue.length) {
        // The one place a message leaves for the CLI, and so the one place that can
        // promise "be this, then do that" happens in that order. A typed turn sends
        // what Claude should be and the instruction back to back, and a control request
        // is not instant — without this wait the instruction can reach Claude while it
        // is still on the old rung, and be refused for a permission that was already
        // granted. Costs nothing once nothing is pending, which is every turn after the
        // first.
        await settled;
        yield queue.shift()!;
      }
      if (done) break;
      await new Promise<void>((r) => { wake = r; });
    }
  }

  const options: Options = {
    cwd: CWD,
    // Added to Claude Code's own prompt rather than replacing it. A plain string here
    // replaces the default, and the working directory is one of the sections that
    // default carries — so Claude did not know where it was standing, resolved a
    // relative path against the home directory instead of the project, and had the
    // write refused for being outside the cwd. Invisible while the only mode was
    // `plan`, because nothing was ever written. What this file holds is a way of
    // speaking, which is an addition to how Claude Code works and not a substitute
    // for it.
    //
    // Read here rather than at module load, so an edit made from the phone reaches
    // the next session. It cannot reach this one: the SDK takes the prompt when the
    // query is built, and rebuilding per turn would throw the warm session away.
    systemPrompt: { type: 'preset', preset: 'claude_code', append: read('claude') },
    includePartialMessages: true,
    permissionMode: PERMISSION_MODE,
    // What the session may become, not what it is. `setPermissionMode` refuses to reach
    // `bypassPermissions` on a session that was not launched for it — and rejects hard
    // enough to take the relay down — so without this the top rung would need a
    // reconnect. The session still starts at PERMISSION_MODE, which is `plan`.
    allowDangerouslySkipPermissions: true,
    // The project's settings and its CLAUDE.md — and deliberately not the user's own
    // ~/.claude/settings.json, whose pre-approved commands (rm, git push, bash) would
    // widen every rung without saying so, and make the phone's description of what
    // Claude may do untrue.
    settingSources: ['project'],
    // Not a restriction — this is the list that runs without asking. Nothing is
    // withheld by leaving a tool off it; `disallowedTools` below is what withholds.
    allowedTools: ['Read', 'WebSearch'],
    // ExitPlanMode joins these now that Claude Code's own prompt is in play and tells
    // Claude the tool exists. The way out of Plan is the capsule on the phone, not
    // something Claude asks for: offered the tool it cannot use, it spends the reply
    // explaining that the exit is disabled instead of saying it cannot write.
    disallowedTools: ['AskUserQuestion', 'Skill', 'ExitPlanMode'],
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
        // The stamp rides only a turn's first frame; everything after it, tool
        // results included, belongs to the turn last stamped — the CLI is sequential.
        // A CLI too old to stamp anything falls back to trusting order, which is what
        // this loop did before there were stamps.
        const stamp = (msg as { user_message_uuid?: string }).user_message_uuid;
        if (stamp) stamps = true;
        if (stamp && msg.type !== 'result') streaming = stamp;
        const alive = wanted !== null && (!stamps || streaming === wanted); // still wanted?
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
          // What the turn cost, which is not what the result says it cost. On a warm
          // streaming session `total_cost_usd` is the running total for the whole
          // query — measured across four turns: 0.017, 0.027, 0.035, 0.118 — so a turn
          // is the difference between two of them. The same subtraction as every timing
          // in this project, for the same reason: two exact readings beat a measurement.
          //
          // A result that cannot be a running total — the zeroed one a crash carries —
          // reports null rather than a number, and leaves `spent` where it was, so one
          // bad result costs that turn's figure and not every figure after it.
          let cost: number | null = null;
          if (typeof msg.total_cost_usd === 'number' && msg.total_cost_usd >= spent) {
            cost = msg.total_cost_usd - spent;
            spent = msg.total_cost_usd;
          }
          // Booked above the match, so an abandoned turn still moves the running
          // total: nobody is listening for what it cost, but it must not be billed to
          // the turn that comes next.
          const mine = wanted !== null && (stamps ? stamp === wanted : true);
          if (!mine) {
            // An interrupted turn's result, or a diagnostic the CLI files as one.
            // Said in the log, where a stray belongs — never on the phone.
            log(`stray result dropped (${msg.subtype}${msg.is_error ? ', error' : ''})`);
            continue;
          }
          wanted = null; // answered; nothing is owed until the next send
          let error: string | null = null;
          if (msg.is_error) error = 'errors' in msg && Array.isArray(msg.errors) ? msg.errors.join('; ') : 'result' in msg ? String(msg.result) : 'unknown error';
          cb.onResult({ sessionId: msg.session_id, costUsd: cost, error, model: model ?? null, permission });
        }
      }
    } catch (e) {
      if (!done) log(`claude stream ended: ${e}`);
    }
  })();

  return {
    send(instruction) {
      wanted = randomUUID();
      opened = false; // this turn announces its own first block
      queue.push({ type: 'user', message: { role: 'user', content: instruction }, parent_tool_use_id: null, uuid: wanted } as SDKUserMessage);
      wake?.();
      wake = null;
    },
    set(wantModel, wantPermission) {
      // Recorded before the answer arrives, so repeating a value costs nothing — and
      // put back if the request is refused, so the next frame tries again instead of
      // believing a change that never happened.
      const applying: Promise<unknown>[] = [];
      if (wantModel && wantModel !== model) {
        const was = model;
        model = wantModel;
        applying.push(q.setModel(wantModel)
          .then(() => log(`model ${wantModel}`))
          .catch((e) => { model = was; fail(`could not switch to ${wantModel}: ${e}`); }));
      }
      if (wantPermission && wantPermission !== permission) {
        const was = permission;
        permission = wantPermission;
        applying.push(q.setPermissionMode(wantPermission)
          .then(() => log(`permission ${wantPermission}`))
          .catch((e) => { permission = was; fail(`could not switch to ${wantPermission}: ${e}`); }));
      }
      // Held so the next instruction waits for it — see `input`. Every rejection is
      // already caught above, so this settles whatever happens and can never strand a
      // turn behind a failed switch.
      if (applying.length) settled = Promise.all(applying);
    },
    interrupt() {
      // Turn-level: stops the running turn, session stays alive for the next send.
      // Stop wanting before asking — the request races the next send, and whichever
      // turn it lands on, that turn's output now matches nothing.
      wanted = null;
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
      console.log(`\n\nfirst token ${first}ms, $${r.costUsd}, ${r.model ?? 'default model'}, session ${r.sessionId}${r.error ? `, error: ${r.error}` : ''}`);
      claude.close();
      process.exit(0);
    },
  });
  claude.send(instruction);
}
