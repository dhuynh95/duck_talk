# app/ — Duck Talk iOS client

SwiftUI, iOS 17+, no external Swift packages. Currently a placeholder screen —
the wired client (session list, chat, SSE against `src/server`) is parked on the
`ios/wired-mvp` branch; pull pieces over from there rather than rewriting them.

## Working loop — use the CLI, not Xcode

```bash
cd app
./dt build          # xcodegen + xcodebuild, output filtered to errors/warnings
./dt run            # build, boot sim, install, launch
./dt shot           # screenshot booted sim -> .build/shot.png, then Read it
./dt logs 10        # app logs for 10s
```

A successful `./dt build` prints nothing. Verify UI changes with
`./dt run && ./dt shot` and read the PNG — don't claim a change works off a
successful compile alone.

Override the simulator with `SIM="iPhone 17" ./dt run`.

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
