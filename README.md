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
started in a terminal. Run it somewhere else tomorrow and it is about that instead.
Then point a client at the address it prints.

You will need:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code), signed in — the relay
  says which account will pay on its third line, asked of the CLI rather than guessed.
  An `ANTHROPIC_API_KEY` in the environment bills the API instead.
- [`GEMINI_API_KEY`](https://aistudio.google.com/apikey) — for the voice. The free tier
  works, no credit card.

Either in the shell or in a `.env` file in that folder:

```bash
GEMINI_API_KEY=AIza...
```

```
duck-talk [--port <n>] [--cwd <path>]
```

`--cwd` if you want to serve a folder you are not standing in. `--port` defaults to
8765. Node 22 or newer.

### The client

The relay is a plain WebSocket server, so the client is separable from it. The one in
this repo is a SwiftUI iPhone app (`app/`) — talk on a walk, read the transcript,
browse and fork past conversations. Build it with `cd app && ./dt run` for the
simulator, or `./dt phone` for a cabled iPhone, which prints the `wss://…ts.net`
address to paste under gear ▸ Server. See [`app/README.md`](app/README.md).

To check the Mac half with no phone at all:

```bash
node server/probe.ts "what is the latest commit"
```

### From source

```bash
git clone https://github.com/dhuynh95/duck_talk.git && cd duck_talk
npm install
npm start     # the relay, watching, serving this repo
```

There is no build step in the loop: Node runs the TypeScript. `npm run build` exists
only for the package, which cannot assume that of a stranger's Node.

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
CI runs all three on every push.

Publishing is one button: **Actions ▸ Release ▸ Run workflow**, pick patch/minor/major.
That verifies, bumps, tags, publishes to npm with provenance, and writes the GitHub
release. It is the only thing that publishes, so the tag and the version on npm cannot
disagree. It needs one repository secret, `NPM_TOKEN`, which must be an npm
**Automation** token.

## License

[MIT](LICENSE)
