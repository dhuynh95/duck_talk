# app/ — Duck Talk iOS client

SwiftUI, iOS 17+, no external Swift packages. Currently a placeholder screen —
the wired client (session list, chat, SSE against `src/server`) is parked on the
`ios/wired-mvp` branch; pull pieces over from there rather than rewriting them.

## Working loop — the `ios-sim` MCP

`run()` is the whole loop: it builds, installs, launches, and returns a screenshot —
or the compiler's errors, or the log tail if the app died. Then `tap(label="…")`,
`swipe`, and `type_text` drive the app, each returning the screen it produced.

Never claim a UI change works off a successful compile — `run()` hands you the
screen, so look at it.

Coordinates are **points** (402×874 on an iPhone 17 Pro), and screenshots are scaled
to exactly that, so a coordinate read off an image goes straight back into `tap`. No
conversion anywhere. `tap(label="Connect")` matches accessibility labels and needs no
coordinates at all — prefer it. There is no `ui` tool: the screenshot shows what's on
screen, and `exec_code` has `ax_tree()` if you ever need the raw tree.

## Voice turns

`play_audio(text="what is two plus two")` speaks to the app as a user would and
returns timing measured from the recorded waveform, plus a screenshot:

```
{"latency_ms": 971, "reply_ms": 997, "question_ms": 1030, "peak_db": -10.7, "gaps": 0}
```

`latency_ms` is end of question → first sound of the reply, as a user hears it.

It works through two virtual audio devices, kept apart on purpose: we play into
`BlackHole 2ch` (what the app listens to) and record `BlackHole 16ch` (what the app
plays into). Nothing becomes sound, so a conversation in the room can't reach the
app and the app's reply can't reach its own microphone. Both devices are recorded by
one ffmpeg process, so the question and reply share a timebase and latency is a
subtraction — no clocks. Needs `brew install --cask blackhole-2ch blackhole-16ch`.

**Changing the audio route while the simulator is booted breaks its audio session** —
every Connect then fails with "microphone format can't be converted". `play_audio`
sets the route and reboots the device for you, then asks you to call `run()` and tap
Connect again. Tap Connect before the first `play_audio`; the app must be live.

For the Mac half alone, with no simulator and no audio devices: `node server/probe.ts
"what is two plus two"` returns what Gemini heard and said in about a second.

Same machinery from a terminal, for humans:

```bash
cd app
./dt run            # build, boot sim, install, launch
./dt build          # compile only; prints just errors and warnings
./dt shot           # screenshot -> .build/shot.png
./dt logs 10        # app logs for 10s
./dt udid           # target simulator, booting it if needed
```

Override the simulator with `SIM="iPhone 17" ./dt run` (`sim.py` follows it).

`dt` owns the lifecycle, `sim.py` exposes it to the model and adds input via `axe`
(`brew install cameroncooke/axe/axe`). Neither duplicates the other — extend the one
whose job it is.

## Project files

`DuckTalk.xcodeproj` is **generated** and gitignored. Edit `project.yml` and
re-run `./dt gen`. Sources are globbed from `DuckTalk/`, so a new `.swift` file
needs no project edit. Never hand-edit `.pbxproj`.

Adding an SPM dependency means editing `project.yml` — ask first, the app is
deliberately dependency-free.

## Backend, when it gets wired

Types mirror `src/shared/types.ts`. Endpoints: `GET /api/config`,
`GET /api/sessions`, `GET /api/sessions/:id/messages`, `POST /api/converse` (SSE).
Backend runs with `npm run dev` at the repo root; the simulator reaches it on
`http://localhost:8000`, a physical iPhone needs the Mac's LAN address.
