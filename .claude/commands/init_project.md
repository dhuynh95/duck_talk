# duck_talk

## What this doc is

A **stable index** into `server/` (the voice relay, Node) + `app/` (the iPhone client, SwiftUI) + `src/` (the original web app and Claude Code backend, untouched by the current work). Code is the source of truth; this file points at it.

Rules to keep it that way:

- **One line per file**: path → purpose. No internal APIs, no flag names, no line refs.
- **If it describes behavior, it belongs in code** (a comment, a docstring, a tool description).
- **If it describes a non-obvious gotcha, the fix is to make the code less surprising**, not to document the surprise.
- **@-load only ground truth that fits**: small, stable files whose content IS the answer. A big file @-referenced is a silent no-op.

Adding a bullet here is a code smell — ask first whether a code change would obviate it.

## Shape

```
iPhone (app/)                  Mac (server/)                    Google
mic ─▶ AudioPipe ─▶ VoiceSession ─ws─▶ server.ts ─▶ Gemini Live 3.1 flash
🔊 ◀─ AudioPipe ◀─ VoiceSession ◀─ws─  server.ts ◀─ audio + transcripts
```

Architecture B: the phone is a mic and a speaker, the Mac holds the Gemini session. Chosen over "phone talks to Gemini directly" because the orchestrator that will sit between Gemini and Claude Code already exists in TypeScript (`src/client/routes/live/gemini.ts`) and belongs on the server, not in two clients. Measured cost of the extra hop: **3–23 ms**, from the relay writing a reply byte to the phone reporting it arrived. A whole turn is 1.0–1.4 s, so Gemini owns essentially all of it. Every turn is recorded in `server/.turns.jsonl`; the app, the relay and the test harness all run on this Mac, so those timestamps share one clock and latency is a subtraction, never a measurement. Claude Code is **not yet** behind the relay; wiring `gemini.ts`'s `converse` tool into `server/` is the next step.

## Core files (@ loaded)

The request path end to end (phone → relay → Gemini), the test harness, and the build loop. Everything else is on-demand reference.

- @server/server.ts
- @server/probe.ts
- @app/DuckTalk/VoiceSession.swift
- @app/DuckTalk/AudioPipe.swift
- @app/DuckTalk/ContentView.swift
- @app/sim.py
- @app/dt
- @app/project.yml
- @app/CLAUDE.md
- @.mcp.json

## Reference files (read on demand)

- `server/README.md` — run instructions, the wire protocol table, and what a turn leaves in `.turns.jsonl`; same content as `server.ts`'s header.
- `src/client/routes/live/gemini.ts` — the orchestrator to port into `server/`: Gemini as STT + tool caller, `converse` tool BLOCKING while Claude streams, approval hold, stop words. Still pins `gemini-2.5-flash-native-audio-preview-12-2025`.
- `src/client/routes/live/tts-session.ts` — second Gemini session used as a streaming TTS for Claude's text; ports with `gemini.ts`.
- `src/client/routes/live/{tools,buffer,voice-approval}.ts` — tool declarations, sentence-boundary buffer, browser keyword listener (the last one has no server equivalent).
- `src/server/{routes,claude-client,cli}.ts` — the Express :8000 backend: Claude Agent SDK wrapper, `POST /api/converse` SSE, session listing from `~/.claude/projects`.
- `src/shared/types.ts` — content-block and session-entry types both old client and backend import.
- `docs/gemini-live-api-swift-reference.md` — raw WebSocket protocol for Gemini Live; the SDK in `server/` hides it, useful when a field name drifts.
- `docs/ios-codebase-guide.md` — describes the parked `ios/wired-mvp` chat client (under its old name, Reduck), not the current app.
- `todos/` — open problems from the web-app era (STT corrections, WebSocket close errors, muting); none addressed by the relay yet.
- `README.md` — the npm-published web product (`npx duck-talk`), which is `src/` only.

## Local dev

Two servers, both started by hand, neither spawned for you. Each keeps running in its own terminal.

```bash
cd server && npm install && npm start   # relay,       :8765, --watch
cd app    && ./dt mcp                   # ios-sim MCP, :8766, hot reload
```

**Start the MCP before Claude Code**, or its tools are simply absent — `.mcp.json` points at a URL and launches nothing. Started it late? `/mcp` reconnects. `ConnectionRefused` there means the server is down, not that the config is wrong.

Relay: no build step, Node ≥ 22.6 runs the `.ts`. Needs `GEMINI_API_KEY` from the root `.env` or the shell. Mac-half check in one second, no simulator and no audio devices: `node server/probe.ts "what is two plus two"`.

App: `run()` builds, installs, launches and returns the screen; `play_audio(text=)` drives one voice turn and reports it, connecting the app itself. Humans use `app/dt`. Simulator default URL `ws://localhost:8765` works as-is; a physical iPhone needs the Mac's LAN address in the URL field.

Fresh clone also needs `brew install xcodegen cameroncooke/axe/axe`, `brew install --cask blackhole-2ch`, and the venv `.mcp.json` and `dt mcp` both point at:

```bash
uv venv --python 3.13 app/.venv && uv pip install --python app/.venv/bin/python fastmcp
```

Original web app: `npm install && npm run dev` at the root (:8000 + Vite). Untouched by, and unaware of, `server/`.

## Instructions

Both `GOOGLE_API_KEY` and `GEMINI_API_KEY` may be set in the shell; `@google/genai` prefers `GOOGLE_API_KEY` and says so in the relay's first log line. If Gemini behaves as if on a different project, that's why.

Model drift is the first suspect after a pause: the relay's `gemini connected (Nms)` log proves the model string and setup shape; a wrong one dies there, in Node, never in Swift. Run `probe.ts` before touching the app.

NEVER use AskQuestions to send structured questions. Raw text always.

All @-referenced files are already loaded in context. Do NOT re-read them.

If you have to read new files:

- Only read new files by transitivity (mentioned in already-loaded files)
- Only on demand.
  Batch read / ls only. No search / Explore agent. Maximize parallel tool calls.

No output token, digest then wait for my input — **unless** an argument tells you to do something (e.g. "boot the relay"), in which case do it right away (see _Local dev_ above), then report.

$ARGUMENTS
