<p align="center">
  <img src="assets/duck_talk_logo.svg" width="80" alt="Duck Talk logo" />
</p>

# Duck Talk

Talk to Claude Code. Hear it talk back. Approve, interrupt, or redirect — all by voice, from anywhere.

The core tech: a generic voice layer that can wrap **any** black-box agent using speech models (Gemini Live to hear, streaming text-to-speech to answer) for low-latency conversations. No modifications to the agent.

```
             Duck Talk            Claude Code
              ┌──────┐          ╔══════════════╗
You ─speech─▶ │ STT  │ ─inst─▶  ║              ║
    ◀─audio── │ TTS  │ ◀─txt──  ║  (any agent) ║
              └──────┘          ╚══════════════╝

inst = instruction, e.g. "What is the latest PR?"
txt = raw stream of tokens
```

## Demo

[![Demo](https://cdn.loom.com/sessions/thumbnails/d1306d2768ed419092824e4420038687-900818bacd366771-full-play.gif)](https://www.loom.com/share/d1306d2768ed419092824e4420038687)

## Quick start

```bash
cd ~/code/the-project-you-want-to-talk-about
GEMINI_API_KEY=AIza... npx duck_talk
```

That's the whole setup. **The folder you run it in is the project Claude works on** —
its files, its git history, and its Claude Code conversations, including the ones you
started in a terminal. It is also where the relay keeps what it learns: a `.duck-talk/`
directory holding the turn records, the corrections, any prompt you edited from the
phone, and one log per run, kept for a week. Run it somewhere else tomorrow and it is about that instead. Then point a client
at the address it prints — [a browser](#web-client) on any device, or [the iPhone app](#your-iphone).

You will need:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code), signed in — the relay's
  last startup line names the account that will pay, asked of the CLI rather than
  guessed from the environment. An `ANTHROPIC_API_KEY` bills the API instead.
- [`GEMINI_API_KEY`](https://aistudio.google.com/apikey) — for the voice. The free tier
  works, no credit card. In the shell, or in a `.env` file in that folder.

The command the package installs is `duck-talk`, and `duck-talk --help` has the rest:
`--cwd` serves a folder you are not standing in, `--port` defaults to 8765, `--awake`
(or `KEEP_AWAKE=1` in `.env`) keeps the machine from idle sleep while it runs —
`caffeinate` on a Mac, `systemd-inhibit` on Linux, and a closed lid still sleeps it —
and `--open` turns the [access key](#the-access-key) off. Node 22 or newer.

### Web client

The relay also serves a page, from the port it listens on, and the page is a client: any
device with a browser — a Linux laptop, an Android phone — can talk to Claude Code through
it, with nothing to install on the device. The page and its WebSocket share one address, so
there is nothing else to run.

- **Talk or type**, in the same conversation: a transcript with the tools Claude used
  between your lines, and the answer read aloud while the microphone is open.
- **Direct or Review**, and which model answers, how hard it thinks, and what it may do —
  Plan, Edit files, or Full access.
- **Past chats** in a drawer — Claude Code's own sessions — with search, star, rename,
  delete and resume. Fork a chat from one of Claude's lines, or edit what you said and run
  it again from there.
- **Photos and long pastes** go with the next instruction: from the camera, the library or
  the clipboard, shrunk to a JPEG first. A paste over 800 characters becomes a chip instead
  of filling the field.
- **`/`** lists the project's skills.
- **Corrections** and the **prompts** the relay says to each model, edited from the gear
  menu.

Start the relay the way the Quick start does — `npm ci && npm start` in a checkout, or
`cd ~/code/the-project && npx duck_talk` — and it prints where the page is, with the key
that lets a browser in:

```
  web          https://your-machine.your-tailnet.ts.net/?key=…
  localhost    http://localhost:8765/?key=…
  web Wi-Fi    http://192.168.1.42:8765/?key=…  typing only — no microphone off localhost
```

**This machine.** `http://localhost:8765/`. Everything works, the microphone too: a
browser counts `localhost` as a secure page.

**Same Wi-Fi.** `http://<this machine's address>:8765/`, which the `web Wi-Fi` row spells
out. Typing only: a browser gives the microphone to an HTTPS page or to `localhost` and
to nothing else, so tapping the microphone here says so instead of failing quietly. It is
plain `http://`, so the key crosses the network in the clear — fine at home, not in a café.

**Anywhere** — another network, cellular — needs the same tunnel the iPhone does, for the
same reasons (see [Your iPhone](#your-iphone)), and the same three steps:

1. Install [Tailscale](https://tailscale.com) on the machine and on the phone, same account.
2. In the admin console, turn on **MagicDNS** and **HTTPS Certificates**
   (`login.tailscale.com/admin/dns`). Once per tailnet.
3. On the machine, once: `tailscale serve --bg 8765`. It survives reboots. On Linux it may
   refuse until you have run `sudo tailscale set --operator=$USER`, once.

The relay prints its addresses when it starts, so start it after step 3, or restart it. The
`web` row is then `https://<machine>.<tailnet>.ts.net/?key=…`: open it on the phone. HTTPS
is what makes it a secure page, and so what gives the microphone to a phone. `tailscale
serve` keeps the relay on your tailnet; it does not put it on the internet. Until it is
set up, that row says so instead of giving an address.

### The access key

The relay can run commands in your project — under Full access, anything — and a tailnet
is shared with whoever else is on it. So by default a connection has to bring a key. The
page itself is served without one; the WebSocket it opens is not, and a socket that
arrives without the key is refused on the upgrade with an HTTP 401, before anything runs.
That covers the chat history, the audio clips and the pictures too.

- The key is made on the first start — 16 random bytes — and kept in `.duck-talk/key`,
  readable by you alone, so it survives a restart and a bookmark keeps working. The relay
  git-ignores that folder for you: it writes a `.duck-talk/.gitignore` of `*`, so neither
  the key nor the logs that hold it can be committed, even by a `git add -A` — there is
  nothing to add to the project's own `.gitignore`.
- The `web` rows end in `?key=…`. Open one and the page moves the key into the browser's
  localStorage and takes it out of the address bar, so it is not left in the history or on
  a screen. A browser that has none is asked for it in one field: paste it from the relay's
  output or from `.duck-talk/key`. Gear ▸ Connection says whether it is saved and has a
  **Forget key** button.
- `DUCK_TALK_KEY=…` sets the key instead, for a relay run from a service manager or a
  container, where a file is the wrong place for it. No file is written then.
- The key is in the startup rows, so each run's log in `.duck-talk/logs/` holds it too;
  those files are readable by you alone.
- **`--open`**, or `DUCK_TALK_OPEN=1`, turns the check off: no key is made, no address
  carries one, and anyone who can reach the port can run Claude Code in your project. A
  page with no key stored asks the relay whether it wants one — the public
  `/access.json`, which says `{"required":false}` for an open relay and never says the
  key — and skips the form.
- **The iPhone app sends no key**, so a relay it talks to has to be started with `--open`.
  The web client does not need that.

### Known limits

- **Voice stops when the screen locks or the tab goes to the background.** The iPhone app
  keeps a call on the lock screen; a browser has nothing like it, and may suspend a hidden
  page's microphone. While the microphone is open the page holds a screen wake lock so the
  screen does not dim, and asks for it again — and wakes the audio — when you come back to
  the page. Claude keeps working on the relay either way.
- **You cannot interrupt a reply by voice while it plays.** A phone's speaker is next to
  its microphone, and what leaks back is Claude's own voice, which the relay would hear as
  you interrupting. So **Mute mic while Claude speaks** (gear menu, on by default) sends
  silence instead of the room while a reply is playing and for 0.3 seconds after its last
  buffer ends — a fixed hold, there is no setting for it. The silence is frames of zeros at
  the usual rate, so the relay does not think you left. Typing and Stop still work. With
  headphones there is no echo to keep out, so turn it off; with the speaker button off,
  nothing plays and the gate never closes anyway.
- **The keyboard.** The page asks for `interactive-widget=resizes-content`, which keeps the
  composer above the on-screen keyboard in Chrome on Android 108 and newer. Other browsers
  may leave the keyboard over it.
- **The ring around the message field** is drawn with `:has()`. A browser without it shows
  only the box's edge changing colour.
- **Safari and iOS have not been tried.** The iPhone has the app.
- **A photo has to be one the browser can decode.** It is turned into a JPEG in the
  browser before it is sent, so a HEIC in a browser with no codec for it is refused, with a
  message saying to try a JPEG or PNG. So is a file over 40 MB.

### Try it on your phone

1. On the laptop, in the project: `npx duck_talk` (`npm start` from a checkout). Wait for
   the `web` rows.
2. Once, if you have not: `tailscale serve --bg 8765`, then restart the relay so its `web`
   row is the `https://` address.
3. On the phone, with Tailscale on, open that address. The page loads, the key leaves the
   address bar, and the header does not say Offline.
4. Type a question and send it. The answer streams in as text.
5. Tap the microphone, allow it, and ask something short out loud. The waveform moves,
   your words appear, and the answer is spoken. Leave it listening past the screen timeout:
   the screen should stay on.
6. Tap **+ ▸ Camera**, take a picture, and ask what is in it. The picture goes with that
   instruction.
7. Change the mode — the capsule that says **Direct**, at the right of the bar, while the
   microphone is off — to **Review**, and say something. Fix a word in the held
   instruction and accept it. Then fork the chat from one of Claude's lines, with the
   branch icon under it.
8. The echo test. On the phone's speaker, ask for a long answer and stay quiet: it should
   play to the end without cutting itself off. Talk over it: nothing happens, and Stop
   stops it. Then plug in headphones, turn off **Mute mic while Claude speaks**, and talk
   over it again: now it stops. If it ever cuts itself off with nobody speaking, put the
   setting back on.

### Your iPhone

The relay is a plain WebSocket server, so the client is separable from it. The one in
this repo is a SwiftUI iPhone app (`app/`) — talk on a walk, read the transcript,
browse and fork past conversations. `cd app && ./dt run` puts it on the simulator,
`./dt phone` on a cabled iPhone. See [`app/README.md`](app/README.md).

The phone has to find the Mac, and the relay says how the moment it starts — one line
for each place a phone can be:

```
  simulator    ws://localhost:8765
  same Wi-Fi   ws://192.168.1.42:8765
  anywhere     wss://your-mac.your-tailnet.ts.net
```

Copy the one that fits under gear ▸ Server in the app. The field checks the address
as you type and says **Reachable** or what went wrong, so a wrong one fails right
there, not a screen later.

**Same Wi-Fi** needs nothing. The Mac's own Wi-Fi address, plain `ws://` — iOS
allows cleartext to a private address, and to nothing else.

**Anywhere** — cellular, another network, a café — needs a tunnel, because your Mac is
behind your router with no public address of its own. Two things are not enough on
their own: forwarding port 8765 on the router gives you a public address, but iOS
refuses `ws://` to it; only `wss://` works off-LAN, and `wss://` needs a real
certificate, which needs a hostname. Tailscale gives you all three at once with no
third party to trust:

1. Install [Tailscale](https://tailscale.com) on the Mac and on the iPhone, same account.
2. In the admin console, turn on **MagicDNS** and **HTTPS Certificates**
   (`login.tailscale.com/admin/dns`). Once per tailnet.
3. On the Mac, once: `tailscale serve --bg 8765`. It survives reboots.

The relay's *anywhere* line then shows `wss://<your-mac>.<tailnet>.ts.net` — no port
in it, because Tailscale answers on 443 with a Let's Encrypt certificate and forwards to
8765 itself. The relay stays a plain WebSocket server that knows nothing about TLS.
When any step is missing, that line says which one instead. And if the door is already
open onto a port nothing answers on — a relay you moved, or one no longer running — the
relay repoints it at itself and says so, rather than leaving you an address that
resolves and answers nothing.

Without Tailscale, the *anywhere* line says so, and the other two still work.

To check the relay's half with no client at all:

```bash
node server/probe.ts "what is the latest commit"
```

It speaks the question with `say` on a Mac and with `espeak-ng` and `ffmpeg` anywhere else
(for example `sudo apt install espeak-ng ffmpeg`); `--file turn.wav` sends a recording
instead and needs only `ffmpeg`.

### From source

```bash
git clone https://github.com/dhuynh95/duck_talk.git && cd duck_talk
npm ci        # exactly what the lockfile says — after every pull, too
npm start     # the relay, watching, serving this repo
```

There is no build step in the loop: Node runs the TypeScript. `npm run build` exists
only for the package, which cannot assume that of a stranger's Node. A `node_modules`
older than the lockfile fails `npm run check` on SDK types that do not exist yet;
`npm ci` is the fix.

The iPhone app is a separate build with its own tooling — see
[`app/README.md`](app/README.md) › Requirements.

The first version of this was a browser client against an Express backend. It is at
the **`web-app`** tag — `git show web-app`. Everything that mattered is in `server/`;
the one piece never ported is its audio calibration loop.

## Why

I wanted a coding assistant I could talk to on a walk — check on
a long-running task, brainstorm architecture, review a plan.
Hands-free, conversational, no laptop required.

STT tools like [SuperWhisper](https://superwhisper.com/) and
[Wispr Flow](https://wisprflow.ai/) get you halfway — you can
dictate, but the agent never talks back. You can bolt TTS onto
Claude Code via MCP, but you're waiting for the full response
before hearing anything.

Voice-native agents like ChatGPT and Gemini Live have the
conversation part down, but they're not connected to your codebase.
They can't run commands, edit files, or see your project. And if
your accent trips up the STT — "Cloud Code" instead of
"Claude Code" — there's no way to catch it before it's sent.

Nothing combines all of this:

|  | Multi turn voice | Audio output | Low latency | No context bloat | Setup |
|---|---|---|---|---|---|
| **STT dictation** | ❌ Push-to-talk | ❌ | ❌ No response | ✅ | ✅ |
| **MCP voice tool** | ❌ Keyboard | ✅ | ❌ After completion | ❌ Extra MCP | ❌ Custom MCP |
| **Duck Talk** | ✅ | ✅ | ✅ | ✅ | ✅ |

## Key features

- **Real-time voice** — talk to Claude Code hands-free. Say "stop" to interrupt mid-response.
- **Streaming TTS** — the answer is read a sentence at a time, as it streams. First audio in about a second, not after completion.
- **Type or talk** — the same conversation either way. A typed instruction opens no voice session at all and gets its answer on screen.
- **Review mode** — see the instruction before it runs. Fix it, send it, or ignore it. No more "Cloud Code" when you said "Claude Code."
- **Correction learning** — the fix is kept, and the next transcription starts from it: the recogniser is handed the words you actually use.
- **Session management** — browse, resume and fork conversations. It is Claude Code's own session store, so a chat you started at the desk carries on from your pocket.

## Architecture

The client is a microphone, a speaker and a keyboard; the machine running the relay
holds the sessions. Claude Code is the black box in the middle, and the relay is the only
thing that knows about all three.

```
phone (app/, web/)            relay (server/)                            Anthropic + Google
mic ─▶ AudioPipe ─▶ VoiceSession ─ws─▶ server.ts ─▶ session.ts ─▶ ears ──▶ Gemini Live (transcribes)
🔊 ◀─ AudioPipe ◀─ VoiceSession ◀─ws─  server.ts ◀─ session.ts ◀─ voice ◀── Gemini TTS  (reads aloud)
⌨️ ─────────────▶ VoiceSession ─ws─▶ server.ts ─▶ session.ts ─┬── claude ◀▶ Claude Code (the agent)
                                                              └── (no ears, no voice)
```

Audio is what buys audio: the ears open on the first microphone buffer and the voice
speaks only where there are ears, so a connection that is only typed to reaches Claude
and never Gemini — and nothing in the URL has to say which kind it is. The ears
transcribe and nothing else, so a finished transcript *is* the instruction, and a
partial arriving while Claude talks is an interruption.

The cost of putting the Mac in the middle measures about **1 ms**. The wait you
actually feel is Claude, and every turn records where its seconds went.

[`server/README.md`](server/README.md) has the wire protocol and the primitives, each
of which runs alone.

## Releasing

`npm run check`, `npm test`, `npm run build`, and `./scripts/install-elsewhere.sh` — which
packs the tarball, installs it into a folder that is not this repo, and starts it there,
then asks it for its page and knocks on its socket with no key. CI runs all four on every
push to `main` and every pull request, and so does the Release workflow before it
publishes anything. The pre-commit hook `npm install` sets up (`scripts/hooks/pre-commit`)
runs the first, third and fourth — not the tests — on any commit that touches `server/`,
`web/`, `scripts/install-elsewhere.sh`, `package.json`, `package-lock.json` or
`tsconfig.json`, so a package that cannot be installed is caught before it is committed.
`git commit --no-verify` skips it once.

Publishing is one button: **Actions ▸ Release ▸ Run workflow**, pick patch/minor/major.
That verifies, bumps, tags, publishes to npm with provenance, and writes the GitHub
release. It is the only thing that publishes, so the tag and the version on npm cannot
disagree. It needs one repository secret, `NPM_TOKEN`, which must be an npm
**Automation** token.

## License

[MIT](LICENSE)
