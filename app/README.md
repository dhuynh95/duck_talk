# Duck Talk iOS

A SwiftUI iPhone client for Duck Talk. Right now it's a placeholder screen plus
the tooling to build, run, and screenshot it from the command line.

## Requirements

- Xcode 16+ (with an iOS simulator runtime: `xcodebuild -downloadPlatform iOS`)
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) — `brew install xcodegen`

Nothing else: no Swift packages, no MCP servers, no CocoaPods.

## Use

```bash
cd app
./dt run      # xcodegen + build + boot simulator + install + launch
./dt shot     # screenshot the running app -> .build/shot.png
./dt logs 10  # stream the app's logs for 10s
./dt build    # compile only; prints just errors and warnings
./dt clean
```

Pick a different simulator with `SIM="iPhone 17" ./dt run`.

Prefer Xcode? `./dt gen && open DuckTalk.xcodeproj`, then ⌘R. The `.xcodeproj` is
generated from `project.yml`, so change project settings there and re-run
`./dt gen` — don't edit them in the Xcode UI.

## Layout

```
DuckTalk/
  DuckTalkApp.swift        entry point
  ContentView.swift        placeholder screen
  Resources/Info.plist
project.yml                XcodeGen spec (the source of truth for the project)
dt                         build / run / shot / logs
```

## The wired client

A full client against the Express backend — session list, chat history with tool
calls, streaming replies over `POST /api/converse` (SSE), and a settings screen
with a server probe — is committed on the **`ios/wired-mvp`** branch. It builds.
It's parked there so `main` stays minimal; bring files across as they're needed.

`docs/ios-codebase-guide.md` maps that client file-by-file onto the Svelte app.
