# Duck Talk Web Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser client for the relay (full parity with the iPhone app), served by the relay itself behind an access key, plus the fixes that make the relay run on Linux.

**Architecture:** `server/` gains one HTTP server (static `web/` + WebSocket upgrade on the same port) and an access key checked on upgrade. `web/` is plain ES modules with JSDoc types, no build step: pure logic modules (pcm, playback, transcript, session, relay) that are unit-tested under `node --test`, and thin browser glue (audio, UI) verified in Chrome. The iPhone app's Swift files are the behavioural reference for every port.

**Tech Stack:** Node ≥ 22 (runs `.ts` directly), `ws`, TypeScript for `server/`, vanilla JS + CSS for `web/`, `node --test`, `tsc` (checkJs) for type checks. Headless Chrome via CDP for browser verification (driver kept in the scratchpad, never committed).

**Spec:** `docs/superpowers/specs/2026-11-19-web-client-design.md` (read it first; this plan argues from it).

## Global Constraints

- Node `>=22`; no build step, no bundler, **no new runtime dependency** (`dependencies` in `package.json` stays `@anthropic-ai/claude-agent-sdk`, `@google/genai`, `ws`).
- Startup lines `simulator  ws://localhost:<port>` and `project  <dir>` stay exactly as printed today (`scripts/install-elsewhere.sh` greps them).
- Wire formats: mic up = PCM Int16 LE, **16 kHz**, mono, binary frames; reply down = PCM Int16 LE, **24 kHz**, mono; everything else JSON text frames per `server/README.md`.
- Access key: 16 random bytes as base64url in `.duck-talk/key`; `DUCK_TALK_KEY` overrides; `--open` / `DUCK_TALK_OPEN=1` disables the check; refusal is HTTP `401` on the WebSocket upgrade; the key rides `?key=`, is moved to `localStorage` and removed from the address bar on first load.
- Palette (CSS custom properties, `color-scheme: dark`): ground `#111827`, surface `#1F2937`, fill `#2C3644`, border `#4B5563`, accent `#FB923C`, text `#F3F4F6` / `#D1D5DB` / `#9CA3AF`.
- Meter: peak dBFS, floor −60, ceiling −16, attack 0.6, release 0.12. Chimes: start after a 2 s dry lull, fade in 0.4 s to volume 0.5, fade out 0.15 s; off when output is off.
- Reconnect backoff: 250 ms doubling to 5 s; resets when a connection lasted > 5 s. Mute sends **zeroed frames at the same rate**. No `reply_in`/`speech_end` marks from the browser.
- Images: JPEG, long edge ≤ 1568 px, quality 0.8. A pasted text over 800 characters becomes a text chip.
- Untrusted text (transcript, chat titles, tool names, corrections, skill descriptions) is only ever set with `textContent`/`createTextNode`.
- Dark theme only; plain-text transcript; manifest only, no service worker.
- Work on a branch `web-client`. Commit messages follow the repo's style (one sentence saying *why*) and end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Commit steps run only once the user has OK'd committing.

## Review Focus

Most likely to bite first; each has its test in the named task.

1. A key that is empty, the wrong length, or missing on the **data** socket must be a clean `401`, never a thrown `timingSafeEqual` or an open socket (Tasks 1, 3).
2. Path traversal on the static server (`/../x`, `/%2e%2e/x`, `/..%2fx`, NUL, `//`) must never read outside `web/` (Task 2).
3. Markup in untrusted text (a chat titled `<img src=x onerror=…>`, Claude replying with `<script>`) must render as text (Tasks 6, 12).
4. A socket that drops mid-turn must reconnect into the same chat with no duplicated lines and with the `claude` frame sent before queued frames (Task 9).
5. Odd media: odd-length or empty PCM chunks, mic denied / no mic, a 12 MP EXIF-rotated photo, a 0-byte or non-image file (Tasks 7, 8, 13).

---

## File Structure

```
server/access.ts          key load/generate/compare, --open        (new)
server/web.ts             static file handler for web/              (new)
server/local-audio.ts     say/afconvert or espeak-ng/ffmpeg shim    (new; dev-tool, excluded from tsconfig)
server/server.ts          http server + gated upgrade               (modify)
server/cli.ts, reach.ts   --open flag, web rows, Linux --awake      (modify)
server/probe.ts, lab.ts   use local-audio.ts                        (modify)
test/*.test.ts            node --test, one file per module          (new)
web/index.html style.css manifest.webmanifest logo.svg chimes.wav   (new)
web/main.js dom.js store.js key.js                                  boot, DOM helper, store, key handling
web/pcm.js playback.js audio.js mic-worklet.js                      audio math, play bookkeeping, browser glue
web/transcript.js session.js relay.js                               frame reducer, chat socket, data socket
web/attach.js skills.js settings.js                                 attachments, / autocomplete, persisted choices
web/ui/*.js                                                         header, transcript view, composer, drawer, sheets
web/tsconfig.json                                                   checkJs config (mic-worklet.js excluded)
```

---

### Task 1: Access key

**Files:** Create `server/access.ts`, `test/access.test.ts`.

**Interfaces — Produces:**
```ts
export function loadKey(file: string, env?: NodeJS.ProcessEnv): string   // DUCK_TALK_KEY, else file (created 0600 with 16 random bytes base64url)
export function keyMatches(supplied: string | null | undefined, key: string): boolean // constant-time, never throws
export function isOpen(argv: string[], env?: NodeJS.ProcessEnv): boolean // --open or DUCK_TALK_OPEN=1
```

- [ ] **Step 1: Write failing tests** in `test/access.test.ts` (use a `mkdtemp` dir): `loadKey creates a 22-char base64url key, mode 0o600, and returns the same key on the next call`; `DUCK_TALK_KEY wins and writes no file`; `keyMatches accepts equal and rejects null, undefined, '', shorter, longer and same-length-different keys without throwing`; `isOpen is true for --open and for DUCK_TALK_OPEN=1, false otherwise`.
- [ ] **Step 2:** Run `node --test test/access.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement the three functions; `keyMatches` compares equal-length buffers with `timingSafeEqual` after a length check.
- [ ] **Step 4:** Run the same command → PASS.
- [ ] **Step 5:** Commit `server/access.ts test/access.test.ts` — "The relay's one gate is a key it makes for itself and keeps beside the project's other state".

### Task 2: Static file handler

**Files:** Create `server/web.ts`, `test/web.test.ts`.

**Interfaces — Produces:** `export function webHandler(root: string): (req: IncomingMessage, res: ServerResponse) => void`. `GET`/`HEAD` only (else 405); `/` → `index.html`; MIME for html, js (`text/javascript`), css, svg, png, wav, json, webmanifest (`application/manifest+json`); headers `Cache-Control: no-cache`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`; anything that resolves outside `root`, contains NUL or a backslash, or is missing → 404.

- [ ] **Step 1: Write failing tests** against `http.createServer(webHandler(tmp))` on port 0, with `tmp/index.html`, `tmp/app.js`, `tmp/style.css` and a `secret.txt` *beside* `tmp`: `GET / is 200 text/html`; `GET /app.js is text/javascript`; `HEAD /style.css is 200 with content-length and no body`; `GET /missing is 404`; `POST / is 405`; and (raw `http.request` so the path is not normalised) `/../secret.txt`, `/%2e%2e/secret.txt`, `/..%2fsecret.txt`, `/sub/../../secret.txt`, `//etc/passwd`, `/%00` each return 404 and never the secret's text.
- [ ] **Step 2:** Run `node --test test/web.test.ts` → FAIL.
- [ ] **Step 3:** Implement: `decodeURIComponent` inside try/catch (bad escape → 404), `path.resolve(root, '.' + decoded)`, require `startsWith(root + sep)`, `createReadStream` with `pipeline`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit — "Static files for the client, served from beside the code and from nowhere else".

### Task 3: One server, gated upgrade, `--open`

**Files:** Modify `server/server.ts` (the `new WebSocketServer({ port })` block at lines 97, 120, 255–281), `server/cli.ts` (flag + `--help` text). Create `web/index.html` (placeholder: `<title>Duck Talk</title>`, replaced in Task 6), `test/relay.test.ts`.

**Interfaces — Consumes:** `loadKey`, `keyMatches`, `isOpen` (Task 1); `webHandler` (Task 2); `packaged('../web/')`, `state('key')` from `server/paths.ts`.

- [ ] **Step 1: Write failing integration tests** in `test/relay.test.ts`: spawn `node server/cli.ts --port <free> --cwd <tmpdir>` with `GEMINI_API_KEY=fake` and wait for the `simulator` line. Assert: `GET /` is 200 and contains `<title>`; a `ws` client to `/?data=1` with no key, with `key=` (empty), and with a short wrong key each get an `unexpected-response` with status 401; with the key read from `<tmpdir>/.duck-talk/key` the first frame is `{"type":"relay","version":…}`; restarted with `--open` the no-key connection opens; no `[n] open …` log line contains the key.
- [ ] **Step 2:** Run `node --test test/relay.test.ts` → FAIL.
- [ ] **Step 3:** In `server.ts` create `http.createServer(webHandler(packaged('../web/')))` and `new WebSocketServer({ noServer: true })`; handle `upgrade`: unless `isOpen`, require `keyMatches(url.searchParams.get('key'), key)` else write `HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n` and destroy; on success `wss.handleUpgrade` then `wss.emit('connection', ws, req)`. Move `listening`/`error` handling (EADDRINUSE text, `reach()` printing) to the HTTP server. `cli.ts`: `--open` sets `DUCK_TALK_OPEN=1` (same pattern as `--awake`); add it to `--help`.
- [ ] **Step 4:** Run → PASS; run `npm run check` → PASS.
- [ ] **Step 5:** Commit — "The relay serves the client on its own port and refuses a socket that has no key".

### Task 4: Startup addresses and Linux

**Files:** Modify `server/reach.ts`, `server/cli.ts`, `server/server.ts` (printing), `server/probe.ts`, `server/lab.ts`, `tsconfig.json` (exclude `server/local-audio.ts`). Create `server/local-audio.ts`, `test/reach.test.ts`, `test/local-audio.test.ts`.

**Interfaces — Produces:**
```ts
// reach.ts: Reach gains the host of the Tailscale door that points at this port
export interface Reach { simulator: string; wifi: string | null; anywhere: string; anywhereHost: string | null }
export function webLines(r: { port: number; wifi: string | null; anywhereHost: string | null; anywhere: string }, key: string | null): string[]
// local-audio.ts
export async function synthesize(text: string, dir: string): Promise<string>   // `say` on darwin, `espeak-ng -w` elsewhere; throws naming what to install
export async function toPcm16k(source: string): Promise<Buffer>                 // `afconvert` on darwin, `ffmpeg -f s16le -ar 16000 -ac 1` elsewhere; WAV header stripped
```

- [ ] **Step 1: Write failing tests:** `webLines` with a host + key → a `web` row `https://<host>/?key=<key>`, a `localhost` row `http://localhost:<port>/?key=<key>`, and a LAN row ending "typing only — no microphone off localhost"; with `anywhereHost: null` the row is `anywhere`'s own text; with `key: null` no `?key=` anywhere. `toPcm16k('server/fixtures/fluent.wav')` returns an even-length non-empty Buffer (skipped when neither `ffmpeg` nor `afconvert` exists).
- [ ] **Step 2:** Run `node --test test/reach.test.ts test/local-audio.test.ts` → FAIL.
- [ ] **Step 3:** Implement; `tailnet()` returns `{ line, host }` (host only when the door points at this port); print `webLines` after the existing rows, and neutralise "Mac" in text printed on non-darwin. `cli.ts`: on `linux`, `--awake` spawns `systemd-inhibit --what=idle --who=duck-talk --why="relay serving" tail --pid=<pid> -f /dev/null` (unref'd; print a line if it errors). `probe.ts`/`lab.ts` call `synthesize`/`toPcm16k` instead of `say`/`afconvert`.
- [ ] **Step 4:** Run the tests → PASS; `npm run check`; run `node server/cli.ts --awake` for 3 s and confirm `systemd-inhibit --list` shows `duck-talk`.
- [ ] **Step 5:** Commit — "The startup lines say where the web client is, and --awake and the probe no longer assume a Mac".

### Task 5: Packaging, CI, `npm test`, web typecheck

**Files:** Modify `package.json` (`files` += `web/`, scripts `test`, `check`), `scripts/install-elsewhere.sh`, `scripts/hooks/pre-commit`, `.github/workflows/ci.yml`, `.gitignore` if needed. Create `web/tsconfig.json`.

**Interfaces — Produces:** `npm test` = `node --test "test/**/*.test.ts"`; `npm run check` = `tsc --noEmit && tsc -p web --noEmit`. `web/tsconfig.json`: `allowJs`, `checkJs`, `noEmit`, `strict`, `lib: ["ES2023","DOM","DOM.Iterable"]`, `module: "ES2022"`, `moduleResolution: "bundler"`, includes `*.js`, `ui/*.js`, excludes `mic-worklet.js`.

- [ ] **Step 1:** Extend `install-elsewhere.sh` so that after the relay is up it asserts `curl -fs localhost:$PORT/ | grep -q '<title>'` and that a keyless WebSocket upgrade (`curl -s -o /dev/null -w '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==' 'localhost:$PORT/?data=1'`) returns `401`. Run it now → expected FAIL until `web/` is packed.
- [ ] **Step 2:** Add `web/` to `files`; add `web/` to the pre-commit regex; add `- run: npm test` after `npm run check` in `ci.yml`.
- [ ] **Step 3:** Run `npm run check && npm test && npm run build && ./scripts/install-elsewhere.sh` → all PASS.
- [ ] **Step 4:** Commit — "A package that cannot serve its own page is caught before it ships".

### Task 6: Client foundation

**Files:** Create `web/index.html`, `style.css`, `manifest.webmanifest`, `logo.svg` (copy `assets/duck_talk_logo.svg`), `chimes.wav` (copy `app/DuckTalk/Resources/chimes.wav`), `main.js`, `dom.js`, `store.js`, `key.js`, `test/key.test.ts`, `test/store.test.ts`, `test/no-innerhtml.test.ts`.

**Interfaces — Produces:**
```js
// store.js
export function createStore(initial) // → { get(), set(patch), subscribe(fn) → unsubscribe }
// key.js
export function takeKey(loc /*{search,pathname,hash}*/, storage /*Storage|null*/, replace /*(url)=>void*/) // → string|null; stores ?key=, replaces URL without it, else reads storage
export function forgetKey(storage)
export function socketUrl(base /*{protocol,host}*/, params /*Record<string,string|undefined>*/, key) // https→wss, http→ws; skips undefined; appends key
// dom.js
export function h(tag, props, ...children)  // sets text with createTextNode, props via setAttribute/addEventListener; never innerHTML
```

- [ ] **Step 1: Write failing tests:** `takeKey stores ?key=abc, calls replace with the URL minus key, and returns abc`; `takeKey falls back to storage and tolerates storage that throws`; `socketUrl maps https→wss, http→ws, skips undefined params and appends key`; `store notifies subscribers once per set and unsubscribes`; `no file under web/ uses innerHTML, outerHTML, insertAdjacentHTML or document.write`.
- [ ] **Step 2:** Run `node --test test/key.test.ts test/store.test.ts test/no-innerhtml.test.ts` → FAIL.
- [ ] **Step 3:** Implement. `index.html`: viewport with `viewport-fit=cover`, manifest link, `<script type="module" src="/main.js">`. `style.css`: the palette as custom properties, safe-area padding, floating glass utility, reduced-motion rule. `main.js`: boot → `takeKey` → if none, render a single "Enter access key" form (stores it, reloads); otherwise render an empty app shell.
- [ ] **Step 4:** Tests → PASS; `npm run check`. Relay + headless Chrome screenshot of `/` at 390×844 shows the shell on the dark ground.
- [ ] **Step 5:** Commit — "A client that boots, finds its key and draws nothing it did not make itself".

### Task 7: Audio math and playback bookkeeping

**Files:** Create `web/pcm.js`, `web/playback.js`, `test/pcm.test.ts`, `test/playback.test.ts`.

**Interfaces — Produces:**
```js
// pcm.js
export class Resampler { constructor(inRate, outRate = 16000); process(input /*Float32Array*/) /*→ Int16Array*/ }
export function int16ToFloat32(bytes /*ArrayBuffer|Uint8Array*/) // trailing odd byte ignored; empty → empty
export function floatToInt16(f)                                  // clamps to ±1
export class Meter { process(samples /*Int16Array*/) /*→ level 0..1*/ }
// playback.js — port of AudioPipe's bookkeeping, no Web Audio
export class PlayQueue {
  constructor({ onDrained, onChime, now, setTimer })       // onDrained(playedMs), onChime(on)
  output = true; waiting = false
  expectReply()
  enqueue(frames) // → { play: boolean, token: number }   output off ⇒ counted + drained at once, play:false
  played(token, frames)  // a scheduled buffer ended
  flush()                // epoch++, queued=0, drained
  get playedMs(); get queued
}
```

- [ ] **Step 1: Write failing tests:** Resampler — 440 Hz sine at 48 kHz → 16 kHz keeps ~440 Hz (zero-crossing count) and amplitude within 10 %; chunking at 1, 480 and 4096 samples gives the same output within ±1 sample count and 1 % amplitude; 44.1 kHz input works. `int16ToFloat32` of a 5-byte buffer yields 2 samples, of an empty buffer none. `floatToInt16([1.5,-1.5])` → `[32767,-32768]`. Meter — silence → 0; one full-scale frame → ≥ 0.6; a following silent frame decays to ≈ 0.88× (±0.01). PlayQueue — `playedMs` grows by frames/24 per `played`; `onDrained(ms)` fires once when the queue empties; a `played` for a token from before `flush()` is not credited; output off counts frames and drains without `play`; with `waiting` and a dry speaker `onChime(true)` fires after 2000 ms and `onChime(false)` fires on the next `enqueue`; no chime while output is off; zero-frame `enqueue` is a no-op.
- [ ] **Step 2:** Run `node --test test/pcm.test.ts test/playback.test.ts` → FAIL.
- [ ] **Step 3:** Implement `Resampler` as a streaming windowed-sinc (or ≥ 4-tap-per-ratio) low-pass + linear interpolation carrying state across calls; the rest follows the Swift in `app/DuckTalk/AudioPipe.swift` (`meter`, `drained`, `settle`, `epoch`).
- [ ] **Step 4:** Tests → PASS; `npm run check`.
- [ ] **Step 5:** Commit — "The parts of the audio path that can be wrong are plain functions with tests".

### Task 8: Browser audio glue

**Files:** Create `web/audio.js`, `web/mic-worklet.js`, `test/audio.test.ts`; scratchpad (uncommitted): `cdp.mjs`.

**Interfaces — Consumes:** `Resampler`, `Meter`, `PlayQueue`, `int16ToFloat32`. **Produces:**
```js
export function micErrorMessage(err /*unknown*/) // → string: NotAllowedError, NotFoundError, NotReadableError, anything else
export class AudioPipe {
  onChunk; onLevel; onDrained; onProblem; onAudio   // callbacks (ArrayBuffer | number | number | string | string)
  muted = false; output = true; waiting = false
  static async requestMic()                          // throws Error(micErrorMessage(e))
  async start(); stop()
  play(pcm /*ArrayBuffer, 24 kHz Int16*/); flush(); expectReply()
}
```
`mic-worklet.js` is an `AudioWorkletProcessor` that imports `Resampler` from `./pcm.js`, resamples from `sampleRate` to 16 kHz and posts ~40 ms Int16 frames. `start()` requests `getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1}})`, resumes the `AudioContext` (called from a user gesture), holds a screen wake lock, and when `muted` posts zero-filled frames of the same length.

- [ ] **Step 1: Write failing tests:** `micErrorMessage` maps `NotAllowedError` → mentions permission/site settings, `NotFoundError` → "no microphone", `NotReadableError` → "in use by another app", a plain string/undefined → generic, never throws.
- [ ] **Step 2:** Run `node --test test/audio.test.ts` → FAIL.
- [ ] **Step 3:** Implement per the interface; scheduling of each reply chunk is an `AudioBuffer` (24 kHz) started at a running `nextTime`, with `PlayQueue` deciding `play`/`played`/`flush`; chimes loop `chimes.wav` through a gain node. If importing `./pcm.js` from the worklet fails in a target browser, inline the resampler into the worklet instead.
- [ ] **Step 4:** Tests → PASS; `npm run check`. Write `cdp.mjs` in the scratchpad (spawn `google-chrome --headless=new --remote-debugging-port=9222 --use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<16k wav>` with Node 22's global `WebSocket` to speak CDP: `evaluate(expr)`, `screenshot(path, w, h)`). With the relay up, evaluate in `http://localhost:8765/`: `const {AudioPipe}=await import('/audio.js'); …` — count bytes from `onChunk` over 2 s (expect ≈ 64 000 ± 10 %) and `onLevel` > 0; then with the mic denied (no `--use-fake-ui…`) confirm `requestMic()` rejects with the permission message.
- [ ] **Step 5:** Commit — "Mic and speaker in a browser, held to the numbers the phone's audio pipe keeps".

### Task 9: Transcript reducer and chat session

**Files:** Create `web/transcript.js`, `web/session.js`, `test/transcript.test.ts`, `test/session.test.ts`.

**Interfaces — Produces:**
```js
// transcript.js — pure port of VoiceSession.handle/commit/take, no sockets or audio
export class Transcript {
  state /* { lines, utterance, heardClip, pending, inFlight, chatId, error, attached } */
  handle(event) // → { waiting?: boolean, flush?: boolean, expectReply?: boolean }  events per server/README.md
  sendTyped(text, given = []); approve(text); show(past, id); attach(item); drop(id)
}
// session.js — owns the socket, the outbox, reconnect and the AudioPipe
export class VoiceSession {
  constructor({ store, urlFor /*(params)=>string*/, makeSocket /*(url)=>WebSocket-like*/, makePipe, setTimer, now })
  listen(); stopListening(); toggleMute(); send(text); approve(text); stopAll()
  use({ model, permission, effort }); attach(content); show(past, id); set working(on)
  reconnect()   // drop the socket and redial with the current urlFor params (mode / auto-correct ride the URL)
}
```

- [ ] **Step 1: Write failing tests.** `transcript.test.ts`: partial `user` frames replace the utterance and add no line; `turn_start` commits exactly one user line; `model` chunks join into one line until a named `tool` starts a tools line and the next `model` starts a new line; a nameless `tool` without `parent` ends the running tools, with `parent` it does not; `interrupted` with `retract` after commit removes the user, tool and model lines and returns the user line's pieces to `attached`; `turn_end` copies `user.uuid/after` and `model.uuid` onto the last user/model lines and clears `inFlight`; `approval` sets `pending` and clears the utterance. `session.test.ts` with a fake socket and timers: `send()` before the socket exists is delivered after the `claude` frame; close while `inFlight` reconnects after 250 ms with `resume=<chatId>` in the URL, doubling to 5000 ms and resetting after a connection that lasted > 5 s; after the reconnect, `turn_end` leaves exactly one user and one model line; `toggleMute` makes subsequent mic frames the same length and all zero; `turn_end` with the mic closed and `working` false closes the socket; `played` is sent with cumulative ms when the pipe drains.
- [ ] **Step 2:** Run `node --test test/transcript.test.ts test/session.test.ts` → FAIL.
- [ ] **Step 3:** Port from `app/DuckTalk/VoiceSession.swift` section by section; the Swift is the spec. The socket is held iff mic open ∨ `inFlight` ∨ `working`.
- [ ] **Step 4:** Tests → PASS; `npm run check`.
- [ ] **Step 5:** Commit — "The conversation's rules, ported with the tests the phone never had".

### Task 10: First usable screen, and the phone spike

**Files:** Create `web/ui/header.js`, `web/ui/transcript-view.js`, `web/ui/composer.js`; modify `web/main.js`, `web/style.css`.

**Interfaces — Consumes:** `VoiceSession`, `createStore`, `h`, `socketUrl`. **Produces:** header (chats button placeholder, status pill "Offline" in red when the relay is not answering, settings placeholder); transcript view (user/model/tools lines, dimmed live utterance, "Working" row, notice/error rows); composer (textarea, send, mic with waveform from `onLevel`, mute, output, stop).

- [ ] **Step 1:** Wire `main.js` so `socketUrl({…}, {mode:'direct'}, key)` feeds `VoiceSession`; typed sends and the mic work; `Esc`/stop stop everything.
- [ ] **Step 2:** With the relay and `cdp.mjs`: type "what branch am I on" and confirm a model line streams into the transcript; with the fake mic (a wav that says it) confirm a user line and spoken-reply bytes arrive. Screenshot at 390×844 and 1280×800 and look at both.
- [ ] **Step 3 — the spike, on the owner's phone:** `tailscale serve --bg 8765` (if it needs it: `sudo tailscale set --operator=$USER`), open the printed `https://…ts.net/?key=…` on the Android phone, talk with the phone speaker, then with headphones. **Report** whether Claude's reply feeds back as interruptions. If it does, implement the smaller fix first — a mic gate in `AudioPipe` that zero-fills mic frames while `PlayQueue.queued > 0` and for 300 ms after — behind a "Headphones" setting that defaults on for speaker use; re-test.
- [ ] **Step 4:** `npm test && npm run check`.
- [ ] **Step 5:** Commit — "The conversation on screen: type, talk, hear it answer".

### Task 11: Data socket and pickers

**Files:** Create `web/relay.js`, `web/settings.js`, `web/ui/sheet.js`, `web/ui/review-card.js`, `test/relaystore.test.ts`; modify `web/ui/composer.js`, `web/ui/header.js`, `web/main.js`.

**Interfaces — Produces:**
```js
// relay.js — port of RelayStore
export class RelayStore { constructor({ store, urlFor, makeSocket, setTimer })
  connect(); disconnect()
  saveCorrection(c); deleteCorrection(at); savePrompt(name, text)
  openChat(id); fork(id, at); star(id, on); rename(id, title); deleteChat(id)
  clip(id) /*→ Promise<Blob>*/; image(id) /*→ Promise<Blob>*/ }
// store keys it sets: connected, relayVersion, corrections (newest first), prompts, models, skills, chats, loaded:{id,messages,forked}|null, error
// settings.js
export function loadSettings(storage); export function saveSettings(storage, s) // { mode, model, effort, permission, autocorrect, output }, try/catch around storage
// sheet.js
export function choiceSheet({ title, choices /*[{id,title,detail}]*/, picked, onPick, trailing? }) // bottom sheet on phones, centered dialog on wide; Esc and backdrop close
```

- [ ] **Step 1: Write failing tests** (`test/relaystore.test.ts`, fake socket): a `relay` frame sets `connected` and `relayVersion`; `corrections` items are stored newest first; `openChat` sets `loaded` to null before sending and a later `chat` frame sets it (so reopening the same chat is a change); `clip(7)` sends `clip_get` and resolves with the next binary frame; reconnect after a drop uses the backoff; `loadSettings` returns defaults when storage throws.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `RelayStore` (hold-and-reconnect like `VoiceSession`, `?data=1`, `{"type":"read"}` on open). Pickers: mode (Direct/Review, editable only while the mic is closed), model capsule (relay's list, short family name from `resolvedModel ?? value`), effort row inside the model sheet (levels from the model's `supportedEffortLevels`, "Default" first, `xhigh` shown as "Extra"), permission (Plan / Edit files / Full access with the Swift's exact `detail` strings). Persist via `settings.js`; push the `claude` frame through `VoiceSession.use`; a mode change calls `VoiceSession.reconnect()`. `review-card.js`: while `transcript.state.pending` is set, the composer shows the held instruction as an editable field with **Accept** (`VoiceSession.approve(text)`); saying "yes"/"no" works server-side with no client code. Desktop keys in the composer: Enter sends, Shift+Enter breaks the line.
- [ ] **Step 4:** Tests → PASS; `npm run check`; Chrome screenshot of the model sheet at both widths.
- [ ] **Step 5:** Commit — "Model, effort, permission and mode, chosen in the browser and remembered by it".

### Task 12: Chats drawer and per-line actions

**Files:** Create `web/ui/drawer.js`, `web/ui/line-actions.js`; modify `web/ui/transcript-view.js`, `web/ui/header.js`, `web/main.js`.

**Interfaces — Consumes:** `RelayStore`, `VoiceSession.show`, `choiceSheet`. **Produces:** drawer (slides in on phones, permanent sidebar ≥ 900 px) with search, starred first, `working` pill, New chat, and a per-chat menu (star, rename, delete with an in-page confirm); per-line actions: user line **Edit** (fork at `after`, open it, put the text in the composer), **Fix what was heard** (opens corrections seeded — Task 14), **play clip** chip; model line **Fork from here**; copy.

- [ ] **Step 1:** Implement; opening a chat calls `RelayStore.openChat` then `VoiceSession.show(messages, id)` when `loaded` changes; thumbnails/clips fetched by id on demand, object URLs revoked on replace.
- [ ] **Step 2:** Chrome check with a hostile chat: rename a chat to `<img src=x onerror="document.title='pwned'">`, type a message that makes Claude echo `<script>document.title='pwned'</script>`, open the drawer; assert `document.title` is unchanged and the text is visible literally. Then delete it.
- [ ] **Step 3:** Chrome check: open a past chat, reload mid-turn and confirm the working chat streams in; fork from a model line and confirm the new chat opens.
- [ ] **Step 4:** `npm test && npm run check`.
- [ ] **Step 5:** Commit — "Past conversations behind a drawer, with edit and fork where the words are".

### Task 13: Attachments, context sheet, skills

**Files:** Create `web/attach.js`, `web/skills.js`, `web/ui/context-sheet.js`, `test/attach.test.ts`, `test/skills.test.ts`; modify `web/ui/composer.js`.

**Interfaces — Produces:**
```js
// attach.js
export function fitWithin(w, h, cap = 1568)      // → { width, height }, never upscales, keeps aspect
export function isLongPaste(text)                // > 800 chars
export function mintId(last, now)                // → max(round(now), last + 1)
export async function toJpegBase64(blob)         // createImageBitmap(blob,{imageOrientation:'from-image'}) → canvas → toBlob('image/jpeg',0.8) → base64; rejects with a readable message for non-images / 0 bytes
// skills.js
export function filterSkills(skills, query)      // query without the slash; names starting with it first, then containing it; empty query → all
```

- [ ] **Step 1: Write failing tests:** `fitWithin(4032,3024)` → `{1568,1176}`; `fitWithin(800,600)` unchanged; `fitWithin(3024,4032)` → `{1176,1568}`; `isLongPaste` false at 800, true at 801; `mintId` strictly increases for equal `now`; `filterSkills(skills,'re')` lists names starting with `re` before names merely containing it, and `''` returns all.
- [ ] **Step 2:** Run `node --test test/attach.test.ts test/skills.test.ts` → FAIL.
- [ ] **Step 3:** Implement. `+` sheet: camera (`<input type=file accept=image/* capture=environment>`), library (`accept=image/*`), permission row. Paste handler on the composer: image from clipboard → chip; text > 800 → text chip; shorter text pastes normally. Chips removable until sent; `VoiceSession.attach` sends `{"type":"attach","id","data"|"text"}`. `/` in the composer opens the skill list filtered with `filterSkills`; selecting inserts `/name `.
- [ ] **Step 4:** Tests → PASS. Chrome checks via `cdp.mjs`: attach a generated 4032×3024 JPEG with EXIF orientation 6 and confirm the sent frame decodes to 1176×1568 upright; attach a 0-byte file and a `.txt` renamed `.jpg` and confirm a readable error and no `attach` frame; paste 5 000 characters and confirm a text chip with the whole text sent.
- [ ] **Step 5:** Commit — "Photos and long pastes ride along with the next instruction, and / runs a skill".

### Task 14: Corrections, prompts, auto-correct, connection

**Files:** Create `web/ui/settings-menu.js`, `web/ui/corrections.js`, `web/ui/prompts.js`, `web/ui/connection.js`; modify `web/ui/header.js`, `web/main.js`.

**Interfaces — Consumes:** `RelayStore`, `choiceSheet`/sheet primitives, `VoiceSession.reconnect()` (auto-correct rides `?correct=1`, so toggling reconnects). **Produces:** settings menu (Prompts, Corrections, Auto-correct toggle disabled while the mic is open, Connection); corrections list/add/edit/delete with a clip player and the Swift's footer text; prompts editor per prompt with its `detail` and a note from `live`; Connection sheet showing status, relay version, "access key in use", **Forget key** (clears storage, reloads to the key form).

- [ ] **Step 1:** Implement; "Fix what was heard" (Task 12) opens the corrections editor seeded with `{heard: line.text, meant: line.text, clip}`.
- [ ] **Step 2:** Chrome checks: add a correction by hand, reload, confirm it persists and appears newest first; edit a prompt and confirm `.duck-talk/prompts` changes on disk; toggle auto-correct and confirm the chat socket reconnects with `correct=1`; Forget key returns to the key form.
- [ ] **Step 3:** `npm test && npm run check`.
- [ ] **Step 4:** Commit — "What the ears keep mishearing, what the relay says to the models, and how to leave".

### Task 15: Polish, widths, docs

**Files:** Modify `web/style.css` and `web/ui/*.js` as needed; modify `README.md` (a "Web client" section next to "Your iPhone", Linux notes, the `--open`/key explanation, Tailscale steps incl. the Linux operator note), `server/README.md` (HTTP + key + `?key=`), `app/README.md` (iPhone app needs `--open`).

- [ ] **Step 1:** Review at 360×740, 390×844, 768×1024 and 1280×800 screenshots of: empty chat, a streaming turn, review card, each sheet, the drawer. Fix overlap, overflow, safe-area and touch-target issues (≥ 44 px), visible focus, ARIA labels on every icon-only button, `prefers-reduced-motion`.
- [ ] **Step 2:** Lighthouse-style checks by hand: tab through the page with the keyboard; `Esc` closes sheets and the drawer; no horizontal scroll at 360 px.
- [ ] **Step 3:** Full verification: `npm run check && npm test && npm run build && ./scripts/install-elsewhere.sh`; then on the phone over Tailscale one full voice turn, one typed turn, one photo, one Review-mode fix, one fork.
- [ ] **Step 4:** Write the docs; confirm every command in them was run.
- [ ] **Step 5:** Commit — "The web client, documented where someone without a Mac will look first".
