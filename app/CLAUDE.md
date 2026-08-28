# app/ — Duck Talk iOS client

SwiftUI, iOS 17+, no external Swift packages. One screen: a voice session against
`server/` (mic → relay → Gemini → speaker). The earlier chat client (session list,
SSE against `src/server`) is parked on the `ios/wired-mvp` branch; pull pieces over
from there rather than rewriting them.

## Working loop — the `ios-sim` MCP

The MCP is an HTTP server you start yourself — `./dt mcp` — and `.mcp.json` points at
its URL. Nothing spawns it, so if the tools are missing it isn't running. It reloads
on every edit to `sim.py`, so a new tool is live on the next call without restarting
Claude Code.

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

`play_audio(text="what is two plus two")` speaks to the app as a user would, then
reports what the turn actually did, plus a screenshot:

```
{"latency_ms": 1243, "to_phone_ms": 1, "voice_ms": 4761,
 "heard": "What is the capital of France?", "said": "The capital of France is Paris..."}
```

Injection is a black box and the result is not. `say` plays into `BlackHole 2ch`, the
device the app listens to, so the question goes through the real microphone path. But
nothing is measured from sound: the relay writes every finished turn to
`server/.turns.jsonl`, and the app reports over the same socket the moment the first
reply byte reached it.

That works because **the app, the relay and this harness all run on this Mac, so they
share one clock.** Every number is a subtraction between two timestamps. Nothing is
thresholded, calibrated, or detected — there is no signal processing left to be wrong.

`latency_ms` is the question finishing → the relay sending the first reply byte:
Gemini plus both network legs, which is what a user waits through. `to_phone_ms` is
that byte reaching the phone — the cost of relaying through the Mac, and so the
number Architecture B lives or dies on. It measures 1–20 ms. `voice_ms` is exact, not
estimated: 24 kHz Int16 is 48 bytes per millisecond, and the relay counts the bytes.

Only the microphone is ours. The reply plays out of whatever output the Mac already
uses, so you can hear turns happen and no second virtual device has to be working.
Needs `brew install --cask blackhole-2ch`.

An audio session is built at launch from the devices the Mac has then, and a change
afterwards breaks it — every Connect fails with "microphone format can't be
converted". So `run()` sets the microphone *before* the simulator boots, and
`play_audio` only checks it and connects the app if it isn't already. Two calls, no
retry dance: `run()`, then `play_audio(...)`.

Anything else that moves CoreAudio under a booted simulator — switching devices by
hand, `killall coreaudiod`, a sleep — breaks its sessions the same way, and there is
no way to see it coming. So `play_audio` recovers instead of predicting: if Connect
fails it restarts the simulator once and tries again, and only then gives up, quoting
the red line the app is showing rather than guessing at a cause.

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
./dt mcp            # serve the ios-sim MCP over HTTP, reloading on every edit
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
