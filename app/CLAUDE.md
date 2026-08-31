# app/ — Duck Talk iOS client

SwiftUI, iOS 17+, no external Swift packages. Two targets: the app, and a widget
extension holding the lock-screen Live Activity. The home screen is the conversation —
a voice session against `server/` (mic → relay → Gemini → speaker) — with past chats
behind the drawer on the left.

The bar under the composer splits at the microphone: what Claude *is* on the left (which
model answers, and what it may do), the session itself on the right (Direct/Review until
it starts, then mute and stop). The left two stay usable while live, because the relay
puts both on the session already running. `Choices.swift` holds the choices and the one
sheet that shows them; the model list comes down the socket rather than being written
into the app, and effort — how hard the model thinks — is a row inside the model sheet,
its levels read off each model's own row in that list.

You can also type. A typed instruction is a socket of its own that lives for one turn,
and the relay opens ears only for a connection that sends audio, so typing costs no
Gemini session and gets no spoken reply. The two are exclusive: touching the field while
listening stops the session. Both carry `resume`, so a typed turn and a spoken one are
the same conversation. The earlier chat client (session list, SSE against the web app's
Express backend, now at the `web-app` tag) is parked on the `ios/wired-mvp` branch;
pull pieces over from there rather than rewriting them.

Two things the phone does that the simulator cannot show you. `UIBackgroundModes:
audio` keeps the microphone open once the screen locks — iOS will not let a
backgrounded app *start* recording, so a session always begins in the foreground. The
Live Activity is what makes a running session visible without unlocking — and mutable
and stoppable, through App Intents that run in the app; it buys no background time of
its own.

## Working loop — the `ios-sim` MCP

The MCP is an HTTP server you start yourself — `./dt mcp` — and `.mcp.json` points at
its URL. Nothing spawns it, so if the tools are missing it isn't running. It reloads
on every edit to `sim.py`, so a new tool is live on the next call without restarting
Claude Code.

`run()` is the whole loop: it builds, installs, launches, and returns a screenshot —
or the compiler's errors, or the log tail if the app died. Then `tap(label="…")`,
`swipe`, and `type_text` drive the app, each returning the screen it produced.

`type_text` pastes; it does not type. Keystrokes arrive as whatever the simulator's
keyboard layout and autocorrect make of them — "what is two plus two" landed as "Abat os
tao plus tzo" — and the pasteboard has neither. It appends at the cursor, because Cmd+A
on this simulator sends the app to the home screen; tap into an empty field.

Never claim a UI change works off a successful compile — `run()` hands you the
screen, so look at it.

Coordinates are **points** (402×874 on an iPhone 17 Pro), and screenshots are scaled
to exactly that, so a coordinate read off an image goes straight back into `tap`. No
conversion anywhere. `tap(label="Accept")` matches accessibility labels and needs no
coordinates at all — prefer it; the listen button is `tap(id="listen")`. There is no `ui` tool: the screenshot shows what's on
screen, and `exec_code` has `ax_tree()` if you ever need the raw tree.

## Voice turns

`play_audio(text="what is two plus two")` speaks to the app as a user would, then
reports what the turn actually did, plus a screenshot:

```
{"latency_ms": 8381, "claude_ms": 6146, "buffer_ms": 30, "tts_ms": 890, "to_phone_ms": 1,
 "voice_ms": 5630, "cost_usd": 0.063,
 "heard": "What time is it?", "said": "It's 8:45 AM, Friday August 28th."}
```

Injection is a black box and the result is not. `say` plays into `BlackHole 2ch`, the
device the app listens to, so the question goes through the real microphone path. But
nothing is measured from sound: the relay writes every finished turn to
`turns.jsonl` under the state directory of whatever folder it was started in — this
repo, so `.duck-talk/turns.jsonl` — and the app reports over the same socket the
moment the first reply byte reached it.

That works because **the app, the relay and this harness all run on this Mac, so they
share one clock.** Every number is a subtraction between two timestamps. Nothing is
thresholded, calibrated, or detected — there is no signal processing left to be wrong.

`latency_ms` is the question finishing → the relay sending the first reply byte:
Gemini routing, Claude thinking, TTS, and both network legs — the whole wait, now
dominated by Claude, not Gemini. `claude_ms` is Claude's slice of it (cold on turn
one, then resumed and fast). `buffer_ms` and `tts_ms` split what used to be one
number: text waiting for a sentence boundary, then the voice model's own latency —
so a slow reply says which of the two to go after. `to_phone_ms` is that byte reaching the phone — the cost
of relaying through the Mac, the number Architecture B lives or dies on; it measures
~1 ms. `voice_ms` is exact: 24 kHz Int16 is 48 bytes per millisecond. `cost_usd` is
what the Claude turn cost.

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
./dt phone          # build signed, install and launch on the iPhone on the cable
./dt mcp            # serve the ios-sim MCP over HTTP, reloading on every edit
```

`./dt phone` needs a signing team in `app/.team` (gitignored) and a phone that is
paired with Developer Mode on. The address to paste under gear ▸ Server is on the
relay's own startup lines — `same Wi-Fi` for a phone on your network, `anywhere` for
Tailscale's `wss://…ts.net`, which reaches the Mac from cellular and carries a
certificate iOS accepts. A LAN `ws://` address works because `NSAllowsLocalNetworking`
covers private addresses — a public `ws://` is refused, so off Wi-Fi it is `wss://` or
nothing. The Server sheet checks the address as you type. README › Your iPhone has the
three Tailscale steps.

Override the simulator with `SIM="iPhone 17" ./dt run` (`sim.py` follows it).

`dt` owns the lifecycle, `sim.py` exposes it to the model and adds input via `axe`
(`brew install cameroncooke/axe/axe`). Neither duplicates the other — extend the one
whose job it is.

## Project files

`DuckTalk.xcodeproj` is **generated** and gitignored. Edit `project.yml` and
re-run `./dt gen`. The same step writes `buildServer.json` (also gitignored, absolute
paths) so SourceKit-LSP reads the generated project instead of compiling each file
alone for macOS — which is what "Cannot find 'Brand' in scope" in an editor means:
run `./dt gen`, or `brew install xcode-build-server` if it is not on the machine.

Sources are globbed from `DuckTalk/` (the app), `DuckTalkWidget/` (the Live Activity)
and `Shared/` (compiled into both — a Live Activity is two processes agreeing on a
shape), so a new `.swift` file needs no project edit. Never hand-edit `.pbxproj`.

The brand is in `Shared/` for the same reason the shape is: `Brand.swift` for the
palette, `Brand.xcassets` for the mark (`Image("Logo")`) and the `AccentColor` the
system tints with. Both targets draw them. `scripts/app-icon.sh` writes that mark and
the app icon from the one drawing in `assets/`, so neither is edited by hand — and
`scripts/filler-sound.py` writes `DuckTalk/Resources/chimes.wav`, the loop the app
plays while a reply is owed, the same way: synthesized from numbers, never edited.

Adding an SPM dependency means editing `project.yml` — ask first, the app is
deliberately dependency-free.
