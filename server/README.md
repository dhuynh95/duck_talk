# server/ — voice relay: phone ⇄ Gemini ⇄ Claude Code

The phone streams mic audio here; this server puts it through Gemini (Live to hear,
text-to-speech to speak) and Claude Code (as the agent), and streams Claude's spoken
answer back. This directory is also the published package — `cli.ts` is what `npx
duck_talk` runs. Each primitive runs alone:

- `ears.ts`   — Gemini Live hearing: audio in → the utterance as it is spoken, then finished. Transcribes only; the finished transcript is the instruction.
- `claude.ts` — Claude Code via the Agent SDK: one instruction → streamed text + tool calls + a session id to resume.
- `voice.ts`  — Gemini text-to-speech, one request per sentence: Claude's text in → 24 kHz PCM out.
- `session.ts`— the turn state machine wiring the three together, per phone connection.
- `chats.ts`  — the conversations Claude Code has in this project: list, read, fork. The SDK's own session store, which is what `?resume=` replays.
- `cli.ts`    — the entry point: the flags, the `.env`, and which folder to serve.
- `paths.ts`  — where that folder puts everything, now that it is a choice.

```bash
npm install
npm start                     # the repo's own relay: node --watch server/cli.ts, :8765
node server/cli.ts --help     # or once installed: duck-talk --help
```

Everything is decided by the folder you start it in. That folder is what Claude works
in, so it is which chats the drawer lists and what `?resume=` can carry on, and it is
where the relay keeps what it learns — `<folder>/.duck-talk/`, holding `turns.jsonl`,
`corrections.jsonl` and any prompt you edited from the phone. Nothing is written beside
the code, because installed by `npx` the code lives in a cache that gets wiped.

Needs `GEMINI_API_KEY` in that folder's `.env` or in the shell, and Claude Code signed
in — or `ANTHROPIC_API_KEY`, which bills the API instead. The relay's third startup
line says which account will actually pay, asked of the CLI rather than guessed from
the environment. `--port` and `--cwd` are the flags; `PORT` and `PROJECT_CWD` are the
same two as environment variables. `STT_MODEL`, `VOICE_MODEL`, `CLAUDE_MODEL`,
`CLAUDE_PERMISSION_MODE` (default `plan`) override the rest. `TURN_TIMEOUT_MS`
(default 180000, `0` disables) caps one turn — a turn that never finishes is
interrupted and the session recovers.

No build step in the repo: Node ≥ 22.6 runs the `.ts`. `npm run build` exists for the
published package, which cannot assume that of a stranger's Node.

## Protocol

| Direction | Frame | Meaning |
|---|---|---|
| phone → server | binary | raw PCM Int16 LE, 16 kHz, mono |
| phone → server | text | `{"type":"text","text"}` — an instruction, typed |
| phone → server | text | `{"type":"mark","name","at"}` — a moment only the phone can see |
| phone → server | text | `{"type":"approve","text"?}` — run a held instruction, as edited |
| server → phone | binary | raw PCM Int16 LE, 24 kHz, mono (Claude's voice) |
| server → phone | text | `{"type":"user"\|"model"\|"tool"\|"approval"\|"interrupted"\|"turn_end"\|"error","text"?}` |

`user` is the utterance as currently heard — it carries the whole thing each time and
replaces what came before, because the guess is revised while you speak; its `partial`
is false on the last one. `model` is Claude's answer as it is spoken and does join up,
`tool` names a tool Claude used, `approval` (review mode) offers a held instruction
for a yes/no, `turn_end` says the reply is finished — the only such signal — and
carries `session`, the chat this connection turned out to be in.

Audio is what buys audio. The ears open on the first microphone buffer and the voice
speaks only where there are ears, so a connection that only ever sends `text` frames
reaches Claude and never Gemini, and nothing in the URL has to say so. A typed
instruction is also never corrected and never held: it cannot have been misheard.

Connect to `ws://<mac>:8765`. One `?mode=`: `direct` (default) runs each instruction
at once, `review` holds it until it is approved — by an `approve` frame, or by saying
"yes". Refusing one is not doing anything with it, so the only way to refuse is to say
"no" or to hang up.
`?correct=1` and `?readback=1` are orthogonal to both. `?resume=<session id>` carries
on a past conversation instead of starting one — any session Claude Code has in this
project, including the ones you started in a terminal.

`?data=1` opens a connection that edits what the relay owns and nothing else — no
voice session, no Gemini, no Claude:

| phone → server | answer |
|---|---|
| `{"type":"corrections"}` (or anything) | the current state |
| `{"type":"correction_save","at","heard","meant"}` | … |
| `{"type":"correction_delete","at"}` | … |
| `{"type":"prompt_save","name","text"}` | … |
| `{"type":"chat_open","id"}` | that chat's messages |
| `{"type":"fork","id","at"}` | a new chat ending at message `at`, then opened |

Every message is answered with `{"type":"corrections","items":[…]}`,
`{"type":"prompts","prompts":[…]}` and `{"type":"chats","chats":[…]}`, so the phone
reads what is there rather than tracking it. One chat's messages are the exception,
sent only when asked for, because they are the one part that is not small.

A prompt is one of the files in `prompts/` — see `prompts.ts`, which is the only
thing that names them. Each arrives with its `title`, a `detail` explaining what it
does, and `live`: whether an edit reaches the session already running. `voice` is
live, because it is re-read per sentence and goes in front of each one — the
text-to-speech API has no rate parameter, so its wording is the only speed control
there is. `claude` is not, because the SDK takes the system prompt when the session's
query is built, so an edit reaches the next session.

## What a turn leaves behind

Every finished turn is appended to `.duck-talk/turns.jsonl` as one line:

```json
{"turn":1,"mode":"direct","heard":"What branch am I on?","instruction":"What branch am I on?",
 "approval":null,"said":"You're on main.","session_id":"0d85ded9-…","heard_at":1787900000000,"claude_first_at":1787900006146,
 "voice_out_at":1787900007000,"reply_in_at":1787900007001,"voice_ms":5630,"cost_usd":0.063}
```

Every timestamp is `Date.now()` on this Mac, where the phone (in the simulator), this
relay and the test harness all run, so a latency is a subtraction, never a
measurement. `heard_at → voice_out_at` is the whole wait a user sits through (now
Claude, not Gemini). `claude_first_at - heard_at` is Claude's own time — cold on
turn one, then resumed and fast. `voice_out_at → reply_in_at` is the cost of the hop.
`voice_ms` is exact: 24 kHz Int16 is 48 bytes per millisecond.

`app/sim.py`'s `play_audio` reads the last line of this file rather than listening to
the reply, which is why measuring a turn needs no working output device — and why it
looks for it in the repo root, where the relay serving this repo puts it.

## Run a primitive alone

From the repo root, not from here: the folder you run one in is the folder it works
on, exactly as it is for the relay.

```bash
node server/claude.ts "what is the latest commit"    # stream Claude's answer to stdout
node server/voice.ts  "Hello there. How are you?"    # write reply.pcm, print timings
node server/ears.ts   --file turn.wav                # 16 kHz mono in → print partials, then the final
node server/probe.ts  "what is the latest commit"    # the whole path, no phone
node server/chats.ts                                 # list them; <id> prints one; fork <id> <uuid> branches
node server/import.ts ~/Downloads/conversation.json  # a conversation from elsewhere, as a chat
node server/lab.ts                                   # hold a Live session open and read its raw messages
```

`probe.ts` is the Mac half end to end: it connects like a phone, speaks, and prints
what Gemini heard and Claude said. The relay log proves the model strings and setup:
a wrong one dies in Node, never in Swift.
