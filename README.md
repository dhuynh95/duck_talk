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
at the address it prints.

You will need:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code), signed in — the relay's
  last startup line names the account that will pay, asked of the CLI rather than
  guessed from the environment. An `ANTHROPIC_API_KEY` bills the API instead.
- [`GEMINI_API_KEY`](https://aistudio.google.com/apikey) — for the voice. The free tier
  works, no credit card. In the shell, or in a `.env` file in that folder.

The command the package installs is `duck-talk`, and `duck-talk --help` has the rest:
`--cwd` serves a folder you are not standing in, `--port` defaults to 8765, `--awake`
(or `KEEP_AWAKE=1` in `.env`) keeps the Mac from idle sleep while it runs. Node 22 or
newer.

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

To check the Mac half with no phone at all:

```bash
node server/probe.ts "what is the latest commit"
```

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

The phone is a microphone, a speaker and a keyboard; the Mac holds the sessions.
Claude Code is the black box in the middle, and the relay is the only thing that knows
about all three.

```
iPhone (app/)                 Mac (server/)                              Anthropic + Google
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

`npm run check`, `npm run build`, and `./scripts/install-elsewhere.sh` — which packs
the tarball, installs it into a folder that is not this repo, and starts it there.
CI runs all three on every push, and so does the pre-commit hook `npm install` sets up
(`scripts/hooks/pre-commit`), on any commit that touches `server/` or the package
config — so a package that cannot be installed is caught before it is committed.
`git commit --no-verify` skips it once.

Publishing is one button: **Actions ▸ Release ▸ Run workflow**, pick patch/minor/major.
That verifies, bumps, tags, publishes to npm with provenance, and writes the GitHub
release. It is the only thing that publishes, so the tag and the version on npm cannot
disagree. It needs one repository secret, `NPM_TOKEN`, which must be an npm
**Automation** token.

## License

[MIT](LICENSE)
