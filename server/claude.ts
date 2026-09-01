/**
 * Claude Code as one long-lived session per chat. Instructions go in
 * through `send`, text and tool blocks come back through callbacks, and a `result`
 * ends each turn. The session stays warm between turns — the first turn pays the
 * ~3s startup, every turn after is ~1s to first token — and `interrupt` stops the
 * current turn without tearing the session down, which is what barge-in needs. That
 * warmth is why the `claude` prompt is read once here and not per turn.
 *
 * Per chat, not per socket: a session belongs to the conversation it is having, and
 * the socket is only whoever is looking at it right now. `claim` is the one door —
 * resuming a chat whose session is still alive reattaches to it instead of spawning a
 * second process onto the same transcript, and `attach` replays the running turn's
 * reply so far before streaming the rest, so switching onto a working chat picks the
 * stream up mid-sentence. `release` is the other side: detaching leaves a busy
 * session to finish on its own (capped by DRAIN_MS, reattachable until then) and
 * closes an idle one, because nothing could ever send to it again.
 *
 * Three things about the session are not fixed that way: which model answers, what it
 * is allowed to do, and how hard it thinks. All are requests the CLI takes mid-session,
 * so `set` puts them on the running session and they hold from the next turn — which is
 * why they reach here as a message from the phone rather than as something chosen when
 * the socket opened. `capabilities()` is the other side of that: the models this Mac can
 * actually offer — each with the effort levels it takes — asked of the CLI instead of
 * written down here.
 *
 * Lifted from the web app's claude-client.ts (the `web-app` tag), but stateful: that
 * backend spawned a fresh subprocess per turn via `resume`, where this keeps one
 * streaming query alive.
 *
 * Subagents need nothing of their own here. The SDK runs them inside the turn and
 * stamps every frame they produce with `parent_tool_use_id`, so they arrive as blocks
 * like any other and the only question is whose they are — see `Block.parent`.
 *
 * A *background* task — an agent or a shell the model sent off to work while the
 * conversation goes on — outlives the turn that launched it, and three facts follow.
 * An interrupt must not kill it, which `perTaskStopAffordance` in the options is for;
 * stopping one is something you ask the model to do, the same way you started it.
 * A close must not kill it either, so `close` drains: the subprocess stays up until
 * the last task settles (or a cap), and only then exits. And when one settles, the
 * CLI says so with a `task_notification` and then opens a turn of its own to narrate
 * the result — a turn no `send` asked for, matched by `ambient` below rather than by
 * a stamp, because a turn Claude starts is still a turn.
 *
 *   node claude.ts "what is the latest commit"     one turn, streamed to stdout
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { query, type AccountInfo, type EffortLevel, type ModelInfo, type Options, type PermissionMode, type Query, type SDKUserMessage, type SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { track } from './live.ts';
import { PROJECT as CWD } from './paths.ts';
import { read } from './prompts.ts';

const MODEL = process.env['CLAUDE_MODEL'];
// How long a session may keep running with nobody attached — for the background tasks
// still in it, or the turn still being answered. A ceiling, not a wait: an idle
// release closes at once, a busy one ends the moment the work settles, and a `claim`
// before then lifts the cap. 0 closes at once, work and all.
const DRAIN_MS = Number(process.env['TASK_DRAIN_MS'] ?? 600_000);
const PERMISSION_MODE = (process.env['CLAUDE_PERMISSION_MODE'] ?? 'plan') as PermissionMode;
const EFFORT = (process.env['CLAUDE_EFFORT'] as EffortLevel | undefined) ?? null;

/** What a session is until something asks it to be otherwise — the environment's
 *  answer, so the phone and the turn log start from the same place the CLI does.
 *  A null effort, like a null model, means whatever the CLI itself defaults to. */
export const DEFAULTS: { model: string | null; permission: PermissionMode; effort: EffortLevel | null } = {
  model: MODEL ?? null,
  permission: PERMISSION_MODE,
  effort: EFFORT,
};

export type { PermissionMode };

/**
 * A tool starting or finishing, which is the whole of what anyone has ever read here.
 *
 * `parent` is the Agent call it happened inside, null for Claude's own — the SDK stamps
 * it on every frame a subagent produces, and it is the only way to tell a subagent's
 * Bash from Claude's. Without it a fan-out looks like one agent doing everything, and a
 * subagent finishing a tool reads as the Agent finishing.
 *
 * The tool's id, its arguments and the result's text travelled here too and no consumer
 * ever took them — the last of those stringified every tool result, file contents
 * included, to be dropped one frame later.
 */
export interface Block {
  /** The tool that started, or null when one finished. */
  name: string | null;
  parent: string | null;
}

export interface Claude {
  /** Start a turn. Only one runs at a time; call after the previous ended or was interrupted. */
  send(instruction: string): void;
  /**
   * What Claude is: which model answers, what it is allowed to do, and how hard it
   * thinks. `effort` is one of the levels the model's own ModelInfo lists, or
   * `'default'` to hand the choice back to the CLI.
   *
   * All three take effect on the turn after this one, on the session already running —
   * so none is decided when the socket opens, and changing your mind costs no restart.
   * Repeating a value it is already set to does nothing.
   */
  set(model?: string, permission?: PermissionMode, effort?: string): void;
  /** Stop the current turn. The session stays warm for the next `send`. */
  interrupt(): void;
  /**
   * Point the callbacks at a new consumer — the socket now looking at this chat.
   * A turn in flight is replayed first, synchronously — its opening kind and the
   * reply so far — so the new consumer sees the whole turn and nothing twice: no
   * live delta can interleave until this returns.
   */
  attach(cb: ClaudeCallbacks): void;
  /** Stop looking — but only if `cb` is still the audience: a socket that lingered
   *  past a switch must not strip the callbacks off whoever attached after it.
   *  Detached, output goes to a sink that keeps the log; the work continues. */
  detach(cb: ClaudeCallbacks): void;
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
   *  `model`, `permission` and `effort` are what the session was set to when it
   *  answered — a null effort is the CLI's own default. */
  onResult(r: { sessionId: string; costUsd: number | null; error: string | null; model: string | null; permission: PermissionMode; effort: EffortLevel | null }): void;
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
  /** The project's skills, each invokable by sending `/name` as an instruction — the
   *  CLI expands it into the turn itself, so the Skill tool stays disallowed and the
   *  model still cannot reach for one on its own. Empty for the same reasons `account`
   *  is null. */
  skills: SlashCommand[];
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
    return { account: init.account, models: init.models, skills: skills(init.commands) };
  } catch {
    return { account: null, models: [], skills: [] }; // no CLI, or one that cannot say — reported below
  } finally {
    q.close();
  }
}

/**
 * The project's skills, out of the CLI's command list — which mixes them in with the
 * built-ins (/usage, /compact). The one mark of a skill is the source suffix the CLI
 * puts on its description, and this relay loads only project settings, so "(project)"
 * is the whole filter. The suffix comes off on the way through: it says where the row
 * came from, which here is always the same place.
 */
function skills(commands: SlashCommand[]): SlashCommand[] {
  const source = / \(project\)$/;
  return commands
    .filter((c) => source.test(c.description))
    .map((c) => ({ ...c, description: c.description.replace(source, '') }));
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

function openClaude(cb: ClaudeCallbacks): Claude {
  // Where the output goes right now. Starts on the opener's callbacks; `attach` points
  // it at whoever looks next, and `detach` at the sink below — so every consumer of a
  // frame reads through this, and swapping the audience is one assignment.
  let target: ClaudeCallbacks = cb;
  const log = (m: string) => (target.log ?? (() => {}))(m);
  /** Said in the log and on the phone: this happened between turns, so no result
   *  will carry it and a silent failure would look like the tap did nothing. */
  const fail = (text: string) => { log(text); target.onError?.(text); };

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
  // A turn nobody sent: after a background task settles, the CLI opens a turn of its
  // own to narrate the result. The notification that precedes it is the delimiter, so
  // this is set there and cleared by everything that outranks it — a send (the user's
  // turn wins), an interrupt (talking over the announcement, the same barge-in as
  // ever), or the ambient turn's own result.
  let ambient = false;
  // Live background tasks, from the CLI's own level signal (replace semantics). What
  // `close` waits on, so a task keeps its process for as long as it is working.
  let tasks = 0;
  let draining: ReturnType<typeof setTimeout> | null = null;
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
  let effort = EFFORT;
  // What `set` is still applying, if anything. An instruction waits for it below.
  let settled: Promise<unknown> = Promise.resolve();
  // Which chat this session turned out to be, and whether work is in flight — the one
  // fact about a chat the list on the phone cannot read off disk, so it is reported
  // to live.ts on every edge that changes the answer. Work is a turn being answered
  // or a background task still going, and both outlive the socket: closing ends the
  // input, not the turn — measured, a turn cut off at 1s ran its tools and finished.
  // The id is null until the CLI's first frame names it, which the loop below reads.
  const live = track();
  let sessionId: string | null = cb.resume ?? null;
  const busy = () => wanted !== null || ambient || tasks > 0;
  const report = () => live.update(sessionId, busy());
  // Nobody attached: nothing to show, but the work goes on and so does its log —
  // named by the chat, since no connection owns these lines.
  const sink: ClaudeCallbacks = {
    onText: () => {}, onBlock: () => {}, onResult: () => {},
    log: (m) => console.log(`[${sessionId?.slice(0, 8) ?? 'claude'}] ${m}`),
  };
  // The turn now running, kept so a socket attaching mid-turn can be shown what it
  // missed: how the turn opened and the reply so far, replayed ahead of the live rest.
  const blank = () => ({ instruction: null as string | null, opens: null as string | null, said: '' });
  let tail = blank();
  /** Actually end the session — what `close` does at once when nothing is working,
   *  and what the drain does when the last task settles or the cap fires. */
  function finish(): void {
    if (draining) { clearTimeout(draining); draining = null; }
    done = true;
    wake?.();
    wake = null;
  }
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
    // Without this the CLI fails closed and an interrupt kills every background task —
    // so a barge-in over the reply silently executed whatever research was still
    // running. Declared, interrupt means only "stop talking". The stop path the
    // declaration promises is conversational: the model stops its own tasks when
    // asked, the same way it starts them.
    perTaskStopAffordance: true,
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
  // Assigned at the bottom of this function, before anything asynchronous can run —
  // the loop below only touches it once frames arrive, and the pool needs the object
  // itself as the thing a later `claim` hands back.
  let self!: Claude;

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
        // Every frame names the chat, and the first one is the earliest anyone can:
        // a fresh session has no id until the CLI mints one. The pool key follows it,
        // so `claim` can find this session from the moment it is findable at all.
        const sid = (msg as { session_id?: string }).session_id;
        if (sid && sid !== sessionId) {
          if (sessionId) pool.delete(sessionId);
          sessionId = sid;
          pool.set(sid, { claude: self, busy, attached: () => target !== sink, instruction: () => tail.instruction });
          report();
        }
        if (stamp && msg.type !== 'result') streaming = stamp;
        // Still wanted? While a send is outstanding the stamp decides; while nothing
        // is owed, the only turn allowed through is an ambient one — the CLI is
        // sequential, so between a task's notification and its narration's result,
        // unstamped frames are that narration.
        const alive = wanted !== null ? !stamps || streaming === wanted : ambient;
        if (msg.type === 'stream_event') {
          if (!alive) continue;
          const event = msg.event as { type?: string; delta?: { text?: unknown }; content_block?: { type?: string } };
          if (!opened && event.type === 'content_block_start') {
            opened = true;
            tail.opens ??= event.content_block?.type ?? 'unknown';
            target.onStart?.(event.content_block?.type ?? 'unknown');
          }
          if (typeof event.delta?.text === 'string' && event.delta.text) {
            tail.said += event.delta.text;
            target.onText(event.delta.text);
          }
        } else if (msg.type === 'assistant') {
          if (!alive) continue;
          for (const b of msg.message.content as { type: string; name?: string }[]) {
            if (b.type === 'tool_use') target.onBlock({ name: b.name!, parent: msg.parent_tool_use_id });
          }
        } else if (msg.type === 'user') {
          if (!alive) continue;
          const content = msg.message.content;
          if (!Array.isArray(content)) continue;
          for (const b of content as { type: string }[]) {
            if (b.type === 'tool_result') target.onBlock({ name: null, parent: msg.parent_tool_use_id });
          }
        } else if (msg.type === 'system' && msg.subtype === 'background_tasks_changed') {
          // The full live set every time membership changes — replace, never count.
          tasks = msg.tasks.filter((t) => !t.ambient).length;
          log(`background tasks: ${tasks}${tasks ? ` (${msg.tasks.filter((t) => !t.ambient).map((t) => t.description).join('; ')})` : ''}`);
          report();
          if (tasks === 0 && draining) finish(); // the drain was for these, and they are done
          if (target === sink && !busy()) finish(); // detached and idle: nobody can send again
        } else if (msg.type === 'system' && msg.subtype === 'task_notification') {
          if (msg.ambient) continue; // housekeeping, not the user's work
          log(`task ${msg.status}: ${msg.summary.slice(0, 200)}`);
          // The narration turn follows; let it through. If a user turn is running the
          // CLI queues the narration behind it, and that turn's result resets `opened`
          // so the narration still announces its own first block.
          ambient = true;
          if (wanted === null) opened = false;
          report();
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
          const mine = wanted !== null ? (stamps ? stamp === wanted : true) : ambient;
          if (!mine) {
            // An interrupted turn's result, or a diagnostic the CLI files as one.
            // Said in the log, where a stray belongs — never on the phone.
            log(`stray result dropped (${msg.subtype}${msg.is_error ? ', error' : ''})`);
            continue;
          }
          if (wanted === null) ambient = false; // a narration's own result is its end
          wanted = null; // answered; nothing is owed until the next send
          opened = false; // a narration queued behind this turn announces its own block
          report();
          tail = blank(); // the turn is over; there is nothing left to replay
          let error: string | null = null;
          if (msg.is_error) error = 'errors' in msg && Array.isArray(msg.errors) ? msg.errors.join('; ') : 'result' in msg ? String(msg.result) : 'unknown error';
          target.onResult({ sessionId: msg.session_id, costUsd: cost, error, model: model ?? null, permission, effort });
          if (target === sink && !busy()) finish(); // detached and idle: nobody can send again
        }
      }
    } catch (e) {
      if (!done) log(`claude stream ended: ${e}`);
    } finally {
      if (sessionId) pool.delete(sessionId); // no stream, nothing to reattach to
      live.close(); // the stream is the work; when it ends, nothing here is working
    }
  })();

  self = {
    send(instruction) {
      wanted = randomUUID();
      ambient = false; // the user's turn outranks a narration
      opened = false; // this turn announces its own first block
      tail = { ...blank(), instruction };
      queue.push({ type: 'user', message: { role: 'user', content: instruction }, parent_tool_use_id: null, uuid: wanted } as SDKUserMessage);
      wake?.();
      wake = null;
      report();
    },
    set(wantModel, wantPermission, wantEffort) {
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
      // 'default' clears the level and hands the choice back to the CLI, the same
      // sentinel the model uses. applyFlagSettings rather than a dedicated control
      // request, because effort is a settings key: the flag layer sits on the running
      // session and holds from the next turn, exactly like the two calls above.
      if (wantEffort !== undefined) {
        const want = wantEffort === 'default' ? null : (wantEffort as EffortLevel);
        if (want !== effort) {
          const was = effort;
          effort = want;
          applying.push(q.applyFlagSettings({ effortLevel: want })
            .then(() => log(`effort ${wantEffort}`))
            .catch((e) => { effort = was; fail(`could not switch effort to ${wantEffort}: ${e}`); }));
        }
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
      ambient = false; // talking over the announcement is the same barge-in as ever
      tail = blank(); // an abandoned turn is not worth replaying to anyone
      report();
      void q.interrupt().catch((e) => log(`claude interrupt: ${e}`));
    },
    attach(next) {
      target = next;
      // Synchronous on purpose: live deltas only arrive through the event loop, so
      // the replay lands whole before any of them — the whole ordering guarantee.
      if (tail.opens || tail.said) {
        target.onStart?.(tail.opens ?? 'text');
        if (tail.said) target.onText(tail.said);
      }
    },
    detach(whose) {
      if (target === whose) target = sink;
    },
    close() {
      if (done || draining) return;
      // A task is the user's work in flight, and the socket closing is not a verdict
      // on it. Keep the subprocess until the last task settles — `finish` runs from
      // the level signal above — or until the cap says enough. unref'd, so a drain
      // never holds a process that is otherwise done (probe, the CLI below).
      if (tasks > 0 && DRAIN_MS > 0) {
        log(`draining ${tasks} background task(s), up to ${DRAIN_MS / 1000}s`);
        draining = setTimeout(finish, DRAIN_MS);
        draining.unref?.();
        return;
      }
      finish();
    },
  };
  // A resumed session knows its chat from birth, so it is findable from birth; a
  // fresh one registers in the loop, on the first frame that mints its id.
  if (sessionId) pool.set(sessionId, { claude: self, busy, attached: () => target !== sink, instruction: () => tail.instruction });
  return self;
}

// --- The pool: one live session per chat -------------------------------------

/** The live sessions by chat id — what `claim` reattaches and `inflight` reads.
 *  `parked` is the DRAIN_MS cap on a session running with nobody attached. */
const pool = new Map<string, {
  claude: Claude;
  busy(): boolean;
  attached(): boolean;
  instruction(): string | null;
  parked?: ReturnType<typeof setTimeout>;
}>();

/**
 * The one door to a Claude session: the live one for this chat, reattached — or a
 * fresh open, resumed from the transcript. The caller cannot tell which, and that is
 * the point: a socket landing on a working chat is replayed the turn in flight and
 * then streams the rest, and lands on a warm process rather than paying a cold start.
 */
export function claim(resume: string | undefined, cb: ClaudeCallbacks): Claude {
  const found = resume ? pool.get(resume) : undefined;
  if (!found) return openClaude({ ...cb, resume });
  if (found.parked) { clearTimeout(found.parked); found.parked = undefined; }
  cb.log?.(`attached to the live session ${resume}`);
  found.claude.attach(cb);
  return found.claude;
}

/**
 * The socket is done with this session; the session decides its own fate. Attached
 * to someone else already — a switch whose old socket closed late — it is theirs, and
 * this release only lets go. Busy — a turn being answered, or background tasks — it
 * stays in the pool, working into the sink, reattachable, and closes on its own when
 * the work settles (`finish` in the loop) or when DRAIN_MS says enough. Idle, it
 * closes now: nobody could send again. `cb` proves who is asking — see `detach`.
 */
export function release(claude: Claude, cb: ClaudeCallbacks): void {
  claude.detach(cb);
  for (const [id, entry] of pool) {
    if (entry.claude !== claude) continue;
    if (entry.attached()) return; // claimed by the next socket; its session now
    if (entry.busy()) {
      entry.parked = setTimeout(() => { pool.delete(id); claude.close(); }, DRAIN_MS);
      entry.parked.unref?.();
    } else {
      pool.delete(id);
      claude.close();
    }
    return;
  }
  claude.close(); // never learned an id, so nothing could ever find it again
}

/** The instruction now being answered in this chat, or null — what lets chats.ts cut
 *  a snapshot where the live replay takes over. */
export function inflight(id: string): string | null {
  return pool.get(id)?.instruction() ?? null;
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
    // A subagent's tools are indented under the Agent call that started them, so a
    // fan-out reads as a fan-out rather than as one agent doing everything.
    onBlock: (b) => process.stderr.write(`\n${b.parent ? '  ↳ ' : ''}[${b.name ?? 'result'}]\n`),
    onResult: (r) => {
      console.log(`\n\nfirst token ${first}ms, $${r.costUsd}, ${r.model ?? 'default model'} at ${r.effort ?? 'default'} effort, session ${r.sessionId}${r.error ? `, error: ${r.error}` : ''}`);
      claude.close();
      process.exit(0);
    },
  });
  claude.send(instruction);
}
