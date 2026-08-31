# duck_talk

## What this doc is

A **stable index** into `server/` (the voice relay, Node — and the published package) + `app/` (the iPhone client, SwiftUI). Code is the source of truth; this file points at it.

Rules to keep it that way:

- **One line per file**: path → purpose. No internal APIs, no flag names, no line refs.
- **If it describes behavior, it belongs in code** (a comment, a docstring, a tool description).
- **If it describes a non-obvious gotcha, the fix is to make the code less surprising**, not to document the surprise.
- **@-load only ground truth that fits**: small, stable files whose content IS the answer. A big file @-referenced is a silent no-op.

Adding a bullet here is a code smell — ask first whether a code change would obviate it.

## Shape

```
iPhone (app/)                 Mac (server/)                              Anthropic + Google
mic ─▶ AudioPipe ─▶ VoiceSession ─ws─▶ server.ts ─▶ session.ts ─▶ ears ──▶ Gemini Live (transcribes)
🔊 ◀─ AudioPipe ◀─ VoiceSession ◀─ws─  server.ts ◀─ session.ts ◀─ voice ◀── Gemini TTS  (reads aloud)
⌨️ ─────────────▶ VoiceSession ─ws─▶ server.ts ─▶ session.ts ─┬── claude ◀▶ Claude Code (the agent)
                                                              └── (no ears, no voice)
```

The conversations are Claude Code's own sessions, so the drawer, `?resume=` and a fork all read one store — `chats.ts` is the only thing that touches it.

Architecture B: the phone is a mic, a speaker and a keyboard, the Mac holds the sessions. Chosen over "phone talks to Gemini directly" because the orchestrator between Gemini and Claude Code belongs on the server, not in two clients. `session.ts` is that orchestrator, and its state is who holds the floor — user, held (review), or claude. `ears` transcribes only, so a finished transcript IS the instruction and a partial arriving while Claude talks is an interruption; `claude` (Claude Code, one warm streaming session) answers, and `voice` (a text-to-speech request per sentence, not a session) reads the answer back. Audio is what buys audio: the ears open on the first microphone buffer and the voice speaks only where there are ears, so a typed instruction — one socket, one turn — reaches Claude and never Gemini, with nothing in the URL saying which kind of connection it is. Both carry `?resume=`, so talking and typing are one conversation. Measured cost of the phone hop: **~1 ms**; the wait a user feels is Claude (a few seconds), recorded per turn in `.duck-talk/turns.jsonl`. The app, the relay and the test harness all run on this Mac, so those timestamps share one clock and latency is a subtraction, never a measurement.

The relay is the published package — `npx duck_talk`, and `cli.ts` is its entry both here and there. That is why nothing writable sits beside the code: **the folder you start it in is the project it works on**, and `<folder>/.duck-talk/` is everything the relay learns about that project — turns, corrections, edited prompts. `paths.ts` is the only file that decides any of that, and the only one to change if it should ever live somewhere else.

## Core files (@ loaded)

The request path end to end (phone → relay → Gemini + Claude), the prompts that decide what each session does, the test harness, and the build loop. Everything else is on-demand reference, reachable from here by transitivity.

- @server/cli.ts
- @server/paths.ts
- @server/reach.ts
- @server/server.ts
- @server/session.ts
- @server/ears.ts
- @server/clips.ts
- @server/voice.ts
- @server/claude.ts
- @server/correct.ts
- @server/corrections.ts
- @server/chats.ts
- @server/probe.ts
- @server/prompts.ts
- @server/prompts/claude.md
- @server/prompts/voice.md
- @server/prompts/correct.md
- @app/Shared/Brand.swift
- @app/DuckTalk/VoiceSession.swift
- @app/DuckTalk/AudioPipe.swift
- @app/DuckTalk/ContentView.swift
- @app/DuckTalk/Chats.swift
- @app/DuckTalk/Clip.swift
- @app/sim.py
- @app/dt
- @app/project.yml
- @app/CLAUDE.md
- @.mcp.json
- @package.json
- @tsconfig.json

## Reference files (read on demand)

- `server/README.md` — run instructions and the wire protocol table; same content as `server.ts`'s header.
- `scripts/install-elsewhere.sh` — packs the package, installs it in a folder that is not this repo, and starts it there. The only test of the thing users actually get; CI and the release both run it.
- `.github/workflows/{ci,release}.yml` — verify on every push; publish from one button, which is the only thing that publishes.
- **`web-app` tag** — the browser client and its Express backend, which this replaced. `git show web-app` for the ancestors of `ears.ts`, `voice.ts` and `claude.ts`, and for the one piece never ported: audio calibration.
- `docs/gemini-live-api-swift-reference.md` — raw WebSocket protocol for Gemini Live; the SDK in `server/` hides it, useful when a field name drifts.
- `docs/ios-codebase-guide.md` — describes the parked `ios/wired-mvp` chat client (under its old name, Reduck), not the current app.
- `todos/` — web-app-era problems, most now solved in `server/` or `app/`: muting, stop words, voice approval, tool streaming, STT corrections. Worth reading for the dead ends they record, especially `correction_gemini_live.md` on the audio calibration loop.
- `server/import.ts` — a conversation from elsewhere written in as a session. Writes the transcript by hand, because there is no API that puts a past conversation into one.
- `server/lab.ts` — holds a Gemini Live session open over HTTP and logs every raw message, for answering what the SDK docs do not.
- `app/Shared/{LiveSession,StopListening}.swift` — the `ActivityAttributes`, and the two App Intents behind the lock-screen card's buttons: mute and stop. Compiled into both targets, and the intents run in the app, which is what lets them touch the session that holds the microphone.
- `app/DuckTalkWidget/LiveActivity.swift` — that card, and the Dynamic Island pill. Draws only; the microphone stays alive because of `UIBackgroundModes`, not because of this.
- `README.md` — the npm page: what `npx duck_talk` does, and how a release is cut.

## Local dev

Two servers, both started by hand, neither spawned for you. Each keeps running in its own terminal.

```bash
npm install && npm start                # relay,       :8765, --watch, serving this repo
cd app    && ./dt mcp                   # ios-sim MCP, :8766, hot reload
```

**Start the MCP before Claude Code**, or its tools are simply absent — `.mcp.json` points at a URL and launches nothing. Started it late? `/mcp` reconnects. `ConnectionRefused` there means the server is down, not that the config is wrong.

Relay: no build step in the loop, Node ≥ 22.6 runs the `.ts`; `npm run build` is for the package only. Needs `GEMINI_API_KEY` and `claude` on PATH, and its third startup line names the account that will pay — asked of the CLI, not guessed. Mac-half check, no simulator and no audio devices: `node server/probe.ts "what is the latest commit"` — seconds, now that Claude answers. Anything from `server/` runs from the repo root, because the folder you run it in is the folder it works on.

App: `run()` builds, installs, launches and returns the screen; `play_audio(text=)` drives one voice turn and reports it, connecting the app itself. Humans use `app/dt`. Simulator default URL `ws://localhost:8765` works as-is. A physical iPhone is `./dt phone`; the address to put under gear → Server is on the relay's own startup lines (`same Wi-Fi`, or `anywhere` via Tailscale) — `reach.ts` is the one place that knows them.

Fresh clone also needs `brew install xcodegen cameroncooke/axe/axe`, `brew install --cask blackhole-2ch`, and the venv `.mcp.json` and `dt mcp` both point at:

```bash
uv venv --python 3.13 app/.venv && uv pip install --python app/.venv/bin/python fastmcp
```

Before a release, or after touching anything that decides what ships: `npm run check && npm run build && ./scripts/install-elsewhere.sh`. The last one is the only check that sees the package the way a stranger does.

## Instructions

Both `GOOGLE_API_KEY` and `GEMINI_API_KEY` may be set in the shell; `@google/genai` prefers `GOOGLE_API_KEY` and says so in the relay's first log line. If Gemini behaves as if on a different project, that's why.

A port already held by a previous session's process: the relay now says so and exits, rather than appearing to start. `lsof -ti tcp:8765 -sTCP:LISTEN | xargs -r kill` clears it, same with `8766` (MCP).

If you are asked to start one yourself, detach it (`nohup … &`). A server started as a tracked background task dies when the session that owns it ends, and the phone then gets a bad response from a proxy with nothing behind it.

NEVER use AskQuestions to send structured questions. Raw text always.

All @-referenced files are already loaded in context. Do NOT re-read them.

If you have to read new files:

- Only read new files by transitivity (mentioned in already-loaded files)
- Only on demand.
  Batch read / ls only. No search / Explore agent. Maximize parallel tool calls.

No output token, digest then wait for my input — **unless** an argument tells you to do something (e.g. "boot the relay"), in which case do it right away (see _Local dev_ above), then report.

$ARGUMENTS
