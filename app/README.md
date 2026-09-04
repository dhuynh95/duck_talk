# Duck Talk iOS

A SwiftUI iPhone client for Duck Talk. The screen is the conversation — a voice
session against the relay in `../server`, mic to the Mac and Claude's answer read
back — with past chats behind the drawer, a call on the lock screen while it runs, and the
tooling to build, run and drive it from the command line.

## Requirements

- Xcode 16+ from the App Store, then `sudo xcode-select -s /Applications/Xcode.app` —
  a Mac with only the Command Line Tools has `xcodebuild` on PATH and it refuses to
  build; `./dt` says so. iOS simulator runtime: `xcodebuild -downloadPlatform iOS`.
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) — `brew install xcodegen`
- [AXe](https://github.com/cameroncooke/AXe) — `brew install cameroncooke/axe/axe`,
  only needed for the MCP server below

No Swift packages, no CocoaPods.

## Use

```bash
cd app
./dt run      # xcodegen + build + boot simulator + install + launch
./dt shot     # screenshot the running app -> .build/shot.png
./dt logs 10  # stream the app's logs for 10s
./dt build    # compile only; prints just errors and warnings
./dt phone    # build signed, install and launch on the iPhone on the cable
./dt mcp      # serve the ios-sim MCP over HTTP, reloading on every edit
./dt clean
```

Pick a different simulator with `SIM="iPhone 17" ./dt run`.

Prefer Xcode? `./dt gen && open DuckTalk.xcodeproj`, then ⌘R. The `.xcodeproj` is
generated from `project.yml`, so change project settings there and re-run
`./dt gen` — don't edit them in the Xcode UI. That step also writes
`buildServer.json`, which is what makes an editor's SourceKit read the generated
project rather than every file alone (`brew install xcode-build-server`).

## Driving the simulator from Claude

`sim.py` is an MCP server, served over HTTP by `./dt mcp` on :8766. `../.mcp.json`
points at that URL and starts nothing, so run it yourself — before Claude Code, or
its tools won't be there (`/mcp` reconnects if you're late). It reloads on every edit
to `sim.py`, so a new tool is live on the next call. It gives Claude eight tools over
the simulator: `run` — build, install, launch and show the
result in one call — plus `screenshot`, `tap`, `swipe`, `type_text`, `play_audio`,
`logs`, and `exec_code`. Every action that changes the screen returns the screen.

Coordinates are points (402×874 on an iPhone 17 Pro), and screenshots are scaled to
exactly that, so what you read off an image is what `tap` takes. `tap(label="Chats")`
works too, matching accessibility labels, and needs no coordinates at all.

`dt` owns the app lifecycle; `sim.py` exposes it and adds input through `axe`. One
job each, no duplicated logic.

`play_audio(text=...)` speaks a voice turn to the app and reports what the turn did,
plus a screenshot. Injection is a black box — `say` plays into `BlackHole 2ch`, which
the app listens to, so the question goes through the real microphone path
(`brew install --cask blackhole-2ch`). The result is not: the relay writes every
finished turn to `../.duck-talk/turns.jsonl`, and the app reports over the same socket
when the first reply byte reached it. The app, the relay and `sim.py` all run on this
Mac, so those timestamps share a clock and every number is a subtraction — nothing is
measured from sound. The reply plays out of your normal output, so you can hear it.

An audio session is built at launch from the devices the Mac has then, and a change
afterwards breaks it, so `run()` sets the microphone before the simulator boots.
Anything else that moves CoreAudio underneath a booted simulator breaks it the same
way and can't be seen coming, so `play_audio` restarts the simulator once and retries
rather than trying to predict it.

Its environment is `app/.venv` (gitignored), which `../.mcp.json` and the type
checker both point at. On a fresh clone:

```bash
uv venv --python 3.13 app/.venv && uv pip install --python app/.venv/bin/python fastmcp
```

## Layout

```
DuckTalk/
  DuckTalkApp.swift        entry point
  ContentView.swift        the conversation, and the chrome floating over it
  ListenButton.swift       the microphone, your voice as a waveform, and `slot`
  VoiceSession.swift       the one socket to the relay: typing, talking, watching; the transcript
  Call.swift               the session as a CallKit call — lock screen, AirPods stem
  AudioPipe.swift          mic in, speaker out; knows nothing about the network
  Chats.swift              the drawer: past conversations, searched and opened
  Choices.swift            mode, model, effort, permission — the sheet that picks one
  ContextSheet.swift       `+`: camera, recent photos, and permission
  Attachment.swift         a picture on its way to Claude, and its thumbnail
  Clip.swift               play back what the ears heard
  SelectableText.swift     a transcript line you can take a piece of
  Relay.swift              the relay's address, checked, and one-shot questions to it
  Prompts.swift            what the relay says to each model, edited from here
  Corrections.swift        what the ears keep mishearing, and the data socket (`RelayStore`)
  Resources/Info.plist     generated by xcodegen from project.yml
Shared/
  Brand.swift              the palette, and the one rule about what floats
  Brand.xcassets           the mark, and the accent the system tints with
project.yml                XcodeGen spec (the source of truth for the project)
dt                         build / run / shot / logs / udid / phone / mcp
sim.py                     MCP server — the same machinery, for the model
```

## The wired client

A full client against the Express backend — session list, chat history with tool
calls, streaming replies over `POST /api/converse` (SSE), and a settings screen
with a server probe — is committed on the **`ios/wired-mvp`** branch. It builds.
It's parked there so `main` stays minimal; bring files across as they're needed.

`docs/ios-codebase-guide.md` maps that client file-by-file onto the Svelte app.
