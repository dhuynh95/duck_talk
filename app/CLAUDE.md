# app/ — Duck Talk iOS client

SwiftUI, iOS 17+, no external Swift packages. Currently a placeholder screen —
the wired client (session list, chat, SSE against `src/server`) is parked on the
`ios/wired-mvp` branch; pull pieces over from there rather than rewriting them.

## Working loop — the `ios-sim` MCP

`run()` is the whole loop: it builds, installs, launches, and returns a screenshot —
or the compiler's errors, or the log tail if the app died. Then `tap(label="…")`,
`swipe`, `type_text`, and `ui()` drive the app, each returning the screen it produced.

Never claim a UI change works off a successful compile — `run()` hands you the
screen, so look at it.

Coordinates are **points** (402×874 on an iPhone 17 Pro), and screenshots are scaled
to exactly that, so a coordinate read off an image goes straight back into `tap`.
`ui()` reports frames in the same space. No conversion anywhere.

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
