# Duck Talk web client — design

Status: draft, awaiting approval. Date: 2026-11-19.

## Intent and why

Duck Talk lets you talk to Claude Code and hear it answer. Today the only client is a
SwiftUI iPhone app, and the relay's docs assume a Mac. The owner has a Linux laptop and
an Android phone, so none of it is usable by them. They want it to work from **any
device with a browser**, with the full feature set of the iPhone app, and the relay
fixed up to run on Linux.

So: a browser client, served by the relay itself, reached over the owner's existing
Tailscale tailnet. The iPhone app stays as it is.

## Goals

- A browser client with **full parity** with the iPhone app (table in *Features*):
  voice and typed conversation, streaming transcript with tool activity, spoken reply,
  Direct/Review modes, model/effort/permission pickers, chats drawer (search, resume,
  new, star, rename, delete, fork, edit), photo and pasted-text attachments, `/skill`
  autocomplete, corrections editor, prompts editor, connection status.
- Phone-first layout that also works properly on a desktop browser.
- The relay runs on Linux, with no Mac-only behaviour left in the way.
- Setup is one command on the relay machine (`tailscale serve --bg 8765`) and one URL
  on the phone.
- Added to the repo without a build step, a bundler or a new runtime dependency.

## Non-goals

- A native Android app, or any change to the iPhone app.
- Voice while the screen is locked or the tab is backgrounded (the iPhone app does this
  through CallKit; a browser cannot do it reliably — see *Known limits*).
- Markdown rendering in the transcript. Replies are written to be read aloud and the
  iPhone app shows plain text; the web client does too.
- Offline use, accounts, multiple users, push notifications.
- A light theme. The brand is dark-first and the iPhone app is pinned to dark.

## Anti-goals (a failure even if it technically works)

- Voice that talks to itself: the microphone hearing Claude's reply and treating it as
  an interruption.
- A UI that is fine on desktop and fiddly on a phone, or the reverse.
- Anything that needs `npm run build` to see a change in the client.
- Making the relay reachable to everyone on a shared tailnet with no gate. The relay can
  be told to run commands (permission picker → "Full access").

## Constraints (found in the repo and on this machine)

- The relay is Node ≥ 22 TypeScript run directly; the package ships `server/` compiled
  to `dist/` (`tsconfig.json`, `rootDir: server`, `files: ["dist/", …]`). `web/` must be
  added to `files`. CI and `scripts/install-elsewhere.sh` start the packaged relay and
  `grep` its startup lines — the `simulator  ws://localhost:<port>` and `project  <dir>`
  lines must stay as they are.
- The protocol is already complete for this: binary PCM Int16 LE 16 kHz mono up, 24 kHz
  mono down; JSON text frames both ways; `?data=1` for the non-voice connection.
  Documented in `server/README.md` and `server/server.ts`. The reference client
  behaviour is `app/DuckTalk/VoiceSession.swift`, `AudioPipe.swift` and
  `Corrections.swift` (`RelayStore`).
- Mic access in browsers needs a secure context: `https://` or `http://localhost`.
  Plain `http://<lan-ip>` gives typing only.
- The relay machine has Tailscale installed and signed in. The tailnet
  (`locationsolutions.com`) is shared with other people's machines, MagicDNS is on, and
  HTTPS certificates are enabled (cert domain
  `shadi-thinkpad-e16-gen-1.tail2d7a48.ts.net`). No `tailscale serve` config exists yet.
  On Linux, `tailscale serve` may need a one-time `sudo tailscale set --operator=$USER`.
- `reach.ts` already runs on Linux (it only shells out to `tailscale` and reads
  `os.networkInterfaces()`); its text and the startup lines say "Mac".
- The only Mac-specific code is `--awake` (`caffeinate`, guarded by
  `process.platform === 'darwin'`) and `say` in `probe.ts`/`lab.ts`.
- Clocks: the relay stamps turn records on its own clock and the iPhone app's
  `reply_in`/`speech_end` marks assume phone and relay share one (true in the simulator).
  A browser on another device does not share it.

## Approaches considered

**A. Plain browser ES modules in `web/`, served by the relay (chosen).** No framework, no
bundler, no new dependency. One origin for page and socket, so no CORS or mixed-content
problems, and `tailscale serve --bg 8765` is the whole setup. Matches the repo's stated
"no build step in the loop" and the iPhone app's no-dependencies rule. Cost: more
hand-written DOM code than a framework would need; mitigated by a small observable store
and a handful of render helpers.

**B. Svelte/React + Vite.** Nicer component code. Adds a build step, devDependencies and a
`dist/` the relay must serve, and `npm start` stops being one step. Rejected: too much
machinery for this repo.

**C. Native Android / cross-platform app.** Needs the Android SDK and APK installs and is
not a browser. Rejected: the owner asked for any device with a browser.

## Design

### Shape

```
Browser (web/)                         Relay (server/)                     Anthropic + Google
mic ─▶ worklet ─▶ session.js ─wss─▶  http+ws on :8765 ─▶ session.ts ─▶ Gemini / Claude Code
speaker ◀─ audio.js ◀─ session.js ◀─wss─      │
data screens ◀──── relay.js ◀──── wss ?data=1 ┘
GET / , /*.js, /*.css  ◀── static files from web/   (same port)
```

Reached through Tailscale: `https://<machine>.<tailnet>.ts.net` → `tailscale serve` →
`127.0.0.1:8765`. The relay stays plain HTTP/WS and knows nothing about TLS, exactly as
it does for the iPhone app today.

### Relay changes (`server/`)

1. **One HTTP server, WebSocket upgrade on it.** `server.ts` creates `http.createServer`
   and attaches `WebSocketServer({ noServer: true })`, handling `upgrade` itself. Port,
   `EADDRINUSE` message and the "bound, then print the addresses" ordering are kept
   (listen events move from `wss` to the HTTP server). Existing connection handling is
   untouched.
2. **`web.ts` (new): static files** from `web/`, found relative to the module
   (`new URL('../web/', import.meta.url)`, which resolves from both `server/` and
   `dist/`). `GET /` → `index.html`; correct MIME types; path traversal refused; `HEAD`
   supported; `Cache-Control: no-cache` so edits show on reload; 404 otherwise. Static
   files carry no secrets and are served without the key.
3. **`access.ts` (new): the access key.** On first start the relay generates 128 bits
   (`crypto.randomBytes(16).toString('base64url')`) and keeps it in
   `.duck-talk/key` (that directory is already per-project and gitignored);
   `DUCK_TALK_KEY` overrides it. The WebSocket upgrade requires `?key=<key>`
   (constant-time compare) and answers `401` otherwise. `--open` (or `DUCK_TALK_OPEN=1`)
   turns the check off, which is what keeps the iPhone app working unchanged. The check
   is on the upgrade, so it covers `?data=1` too — and with it chat history, clips and
   images.
4. **Startup lines.** Add a `web` row to the addresses `reach.ts` prints: the Tailscale
   `https://` URL with `?key=…` when `tailscale serve` is set up (otherwise the one line
   saying what is missing, as today); `http://localhost:8765/?key=…`, which gets the
   microphone on the relay machine itself; and the LAN `http://<ip>:8765/?key=…`
   marked "typing only — no microphone off localhost". The `simulator` and `project`
   lines are unchanged. Wording that says "Mac" is made neutral where it is printed on
   other platforms.
5. **Linux.** `--awake` on Linux holds an idle inhibitor tied to the relay's pid
   (`systemd-inhibit --what=idle … tail --pid=<pid> -f /dev/null`, same "ends however
   this process ends" property as `caffeinate -w`); if `systemd-inhibit` is missing it
   says so. `probe.ts` and `lab.ts` fall back from `say` to `espeak-ng` (or any TTS the
   user names) when `say` is absent, and `probe.ts --file` keeps working everywhere.
6. **Packaging and CI.** `package.json` `files` gains `web/`; `scripts/hooks/pre-commit`
   treats `web/` as shipping; `scripts/install-elsewhere.sh` additionally checks that
   `GET /` returns the page and that a WebSocket upgrade without the key is refused.

### Client (`web/`)

No build step: `index.html`, `style.css`, ES modules loaded with `<script type="module">`,
one AudioWorklet file, the duck logo as SVG, `chimes.wav` (copied from
`app/DuckTalk/Resources/`; it is generated by `scripts/filler-sound.py`), a web app
manifest so Android Chrome can "Add to Home screen" and run it full-screen.

Modules (names are the builder's to adjust):

| File | Job | Reference in the iOS app |
|---|---|---|
| `main.js` | boot, key handling, wiring, screen state | `ContentView.swift` |
| `store.js` | tiny observable (`get/set/subscribe`) | `@Observable` |
| `session.js` | the one chat socket: typing, talking, watching, transcript lines | `VoiceSession.swift` |
| `relay.js` | the `?data=1` socket: corrections, prompts, models, skills, chats, chat messages, clips, images; reconnect with backoff | `RelayStore` |
| `audio.js` | mic capture, 16 kHz framing, level meter, playback queue, `played` accounting, chimes, wake lock | `AudioPipe.swift` |
| `mic-worklet.js` | AudioWorkletProcessor: resample to 16 kHz Int16, emit frames | tap + `AVAudioConverter` |
| `attach.js` | image → JPEG ≤1568 px long edge, q 0.8; paste → text chip | `Attachment.swift` |
| `ui/*.js` | header, transcript, composer, drawer, sheets (model, effort, permission, mode, context, corrections, prompts, connection) | `ContentView`, `Chats`, `Choices`, `ContextSheet`, `Corrections`, `Prompts` |

Everything is `// @ts-check` with JSDoc types, checked by `tsc` (allowJs/checkJs, DOM
lib) as part of `npm run check`, so there is editor help and a typecheck without a build.

### Session semantics (port, don't reinvent)

`session.js` ports `VoiceSession.swift` faithfully; that file is the specification and the
builder should read it end to end. The behaviours that are easy to get wrong:

- One chat socket per chat on screen (`?mode=…&correct=…&resume=<chatId>`); the
  microphone is audio frames on it, not a different connection. The socket is held while
  the mic is open, a turn this screen sent is running, or the data socket says the chat
  is `working`; otherwise it is closed and the relay keeps working.
- Reconnect with backoff (250 ms doubling to 5 s; a connection that lasted >5 s resets
  it); the reconnect carries `resume=<chatId>`; an outbox holds frames sent before the
  socket exists; the `claude` frame (model/permission/effort) and pending `attach`
  frames are sent first on every new socket.
- `user` frames replace the utterance; it joins the transcript only when the relay shows
  it ran (`turn_start`, `model`, `tool`, or `approve`). `interrupted` with `retract`
  removes what that turn committed and hands attachments back to the composer.
  `turn_end` carries the message uuids that make a line editable/forkable.
- Mute sends **zeroed frames at the same rate**, never silence-by-omission — the relay
  reads a gap as the client going away and closes the ears after two seconds.
- `played`: report cumulative reply milliseconds actually played whenever the speaker
  runs dry; `flush()` on `interrupted`; reset the count on `turn_start`. Queued-buffer
  bookkeeping needs an epoch so buffers dropped by a flush are not credited as heard.
- `output` off consumes replies on arrival (still counted) rather than dropping them.
- The browser sends **no** `reply_in` / `speech_end` timing marks, because its clock is
  not the relay's; turn records simply have those fields empty for web turns. Note-only
  marks (mute, audio route events) are fine.

### Audio

- Capture: `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true,
  autoGainControl: true, channelCount: 1 } })` into an `AudioContext`, an
  `AudioWorkletNode` resamples the context rate (usually 48 kHz) to 16 kHz Int16 with a
  proper low-pass before decimation, and posts steady 20–50 ms frames to the main
  thread, which sends them as binary frames. The resampler is a pure function so it can
  be tested without a browser.
- Playback: each 24 kHz Int16 chunk becomes an `AudioBuffer` scheduled back to back on
  the same context; `onended` drives the played count and the dry/chime logic; flush
  stops every scheduled source.
- Level meter: peak dBFS, floor −60, ceiling −16, attack 0.6, release 0.12 — the same
  numbers as the iPhone app, so the waveform feels identical.
- Chimes: the wait loop under a running turn — start after a 2 s dry lull, fade in
  0.4 s to volume 0.5, fade out 0.15 s when reply audio exists, off when output is off.
- The `AudioContext` is created/resumed inside the tap on the mic button (autoplay
  policy). Typed turns get no spoken reply unless the mic is open, as on the phone.
- A screen **Wake Lock** is held while the mic is open, and re-requested when the page
  becomes visible again.
- Headphones are recommended in the UI copy: browser echo cancellation is good but not
  perfect on every Android device, and a speaker-fed mic is the worst case for
  interruptions (see *Risks*).

### Features (parity with the iPhone app)

| Area | Behaviour |
|---|---|
| Conversation | Plain-text transcript: your lines (dimmed while still being transcribed), Claude's lines streaming, a collapsed tools row ("Read ×3, Bash") with a running indicator, a "Working" row while a turn is in flight, notices ("Reconnecting — Claude keeps working.") and errors |
| Voice | Mic button with live waveform; mute; output on/off; stop (Claude and listening); state "connecting / live" |
| Typing | Growing textarea; Enter sends and Shift+Enter breaks the line on desktop; the send button is always there; typing mid-turn barges in |
| Review mode | Held instruction shown as an editable card with Accept; spoken "yes/no" works as on the phone; the instruction can be fixed before it runs |
| Pickers | Mode (Direct/Review, before a session starts), model (list from the relay, short family name in the capsule), effort (levels from the chosen model's row), permission (Plan / Edit files / Full access, with the same warnings) |
| Attachments | `+` sheet: camera / file chooser (mobile: `capture` and gallery); paste an image or text from the clipboard; images resized to JPEG ≤1568 px and sent as `attach`; pasted text over 800 characters becomes a TXT chip sent whole; chips removable until sent; thumbnails of past images via `image_get` |
| Skills | Typing `/` lists the project's skills filtered locally from the `skills` frame; picking inserts `/name`; sending runs it |
| Chats | Drawer (persistent sidebar on wide screens): search, starred first, `working` pill, New chat; per-chat menu: star, rename, delete (confirmation built into the page) |
| Per-line actions | Your line: **Edit** (fork at `after`, reopen, text back in the composer), **Fix what was heard** (opens corrections seeded with the line + clip); Claude's line: **Fork from here**; heard lines have a **play clip** chip (`clip_get` → WAV → `<audio>`); copy text |
| Corrections | List, add by hand, edit, delete, play the clip; "Used to bias the recogniser…" footer; Auto-correct toggle (reconnects the chat socket, as `?correct=1` rides the URL) |
| Prompts | One editor per prompt from the relay, with its `detail` text and "takes effect next sentence / next session" from `live` |
| Connection | Status pill in the header ("Offline" in red when the data socket is down); Connection sheet: relay version, whether the key is in use, "Forget key / sign out" |

### Look

The iPhone app's brand, in CSS custom properties: ground `#111827`, surface `#1F2937`,
control fill `#2C3644`, border `#4B5563`, accent `#FB923C`, text `#F3F4F6` /
`#D1D5DB` / `#9CA3AF`; `color-scheme: dark`; the duck logo from `assets/duck_talk_logo.svg`.
The rule from `Brand.swift` carries over: the transcript is flat and runs edge to edge;
anything floating over it (header, composer, "New chat") is translucent with a blur and a
shadow. Layout: single column on phones (drawer slides in from the left; sheets rise from
the bottom); at ≥ ~900 px the drawer becomes a permanent sidebar and the conversation
column is centered with a readable max width. Honour `env(safe-area-inset-*)`,
`prefers-reduced-motion`, 44 px minimum touch targets, visible focus, ARIA labels on
icon buttons, `Esc` closes a sheet.

### State kept in the browser

`localStorage`, every access in try/catch: access key, mode, model, effort, permission,
auto-correct, output on/off, last open chat id. Nothing else; the relay owns the rest.

### Security

The key is the only gate. `tailscale serve` (not `funnel`) keeps the relay on the
tailnet, but the tailnet is shared, so the key is on by default. First visit uses the
printed URL with `?key=…`; the page moves the key to `localStorage` and removes it from
the address bar (`history.replaceState`). With no key the page shows a single
"Enter access key" field. The key never goes in a path or in static responses, and the
startup log (which already lands in `.duck-talk/`) is the only other place it is
written. `--open` is documented as "anyone who can reach the port can run Claude Code
here".

## Verification

- `npm run check` (server + web JSDoc types) and `npm run build` stay green;
  `install-elsewhere.sh` still passes and now also proves page-served and key-refused.
- `npm test` (new, `node --test`, no dependency) for pure logic: resampler and PCM
  conversion; the session reducer fed recorded frame sequences (utterance replace, commit
  points, retract, `turn_end` uuids, played accounting with a flush); key compare;
  static server path traversal and MIME.
- Relay + Gemini/Claude end to end: `node server/probe.ts --file` still works against the
  new HTTP server.
- Browser: scripted run with the installed Chrome using
  `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav>` (driver
  kept out of the repo's dependencies) to prove mic → transcript → reply audio on
  desktop; then a **real Android phone over Tailscale** for echo behaviour, wake lock,
  camera/gallery attach, and layout. The UI is looked at in screenshots at phone and
  desktop widths before it is called done.

## Known limits and risks

- **Locked screen / backgrounded tab:** Android may suspend the mic. Wake Lock avoids the
  screen dimming mid-conversation; typed chats and streamed replies keep working.
- **Echo on speaker:** if an Android device's echo cancellation lets the reply back into
  the mic, the relay will hear itself as a barge-in. Early spike on the real phone
  decides whether more is needed (headphones guidance, a short mic gate while reply audio
  plays, or both).
- **Tailscale on Linux** may need the one-time operator setting before `serve` works
  without sudo; the startup line says so when `serve` fails.
- **iPhone app** only works against a relay started with `--open` (it sends no key).
- Browsers differ on `AudioContext` sample rate and `AudioWorklet` timing; frames must be
  rate-independent and the first Android run may need tuning.

## Calls made without being asked (for the reader to check)

1. Approach A, and serving the client from the relay on the same port.
2. The access key is **on by default**, off with `--open`; this is a behaviour change for
   the iPhone app against a default relay.
3. Web client sends no timing marks (clock differs); turn records for web turns lack
   `reply_in_at`/`speech_end_at`.
4. JSDoc `@ts-check` for the web code, typechecked by `tsc`; `node --test` added.
5. Dark theme only; plain-text transcript.
6. Manifest-only PWA (Add to Home screen), no service worker.
7. `systemd-inhibit` for `--awake` on Linux; `espeak-ng` fallback for `probe.ts`.
8. The iPhone app's "Server" sheet becomes a "Connection" sheet (no address to type; the
   address is the page's own origin).
9. This document is written but **not committed**.

## Left to the builder

File and module names; exact frame size and resampler filter; exact breakpoints and
component styling within the brand above; icon generation for the manifest; copy for
empty states and errors; ordering of work (suggested: relay serving + key → audio spike on
the phone → session.js and transcript → composer/pickers → drawer → attachments →
corrections/prompts → polish).
