# server/ — voice relay: phone ⇄ Gemini ⇄ Claude Code

The phone streams mic audio here; this server puts it through Gemini (Live to hear,
text-to-speech to speak) and Claude Code (as the agent), and streams Claude's spoken
answer back. Four primitives, each runnable alone:

- `ears.ts`   — Gemini Live hearing: audio in → the utterance as it is spoken, then finished. Transcribes only; the finished transcript is the instruction.
- `claude.ts` — Claude Code via the Agent SDK: one instruction → streamed text + tool calls + a session id to resume.
- `voice.ts`  — Gemini text-to-speech, one request per sentence: Claude's text in → 24 kHz PCM out.
- `session.ts`— the turn state machine wiring the three together, per phone connection.
- `chats.ts`  — the conversations Claude Code has in this project: list, read, fork. The SDK's own session store, which is what `?resume=` replays.

```bash
cd server
npm install
npm start          # node --env-file-if-exists=../.env --watch server.ts  (port 8765)
```

Needs `GEMINI_API_KEY` and `ANTHROPIC_API_KEY` (or a logged-in `claude`) in the root
`.env` or the shell, and `claude` on PATH. `PROJECT_CWD` is the repo Claude works in
(default: the repo root). `STT_MODEL`, `VOICE_MODEL`, `CLAUDE_MODEL`, `CLAUDE_PERMISSION_MODE`
(default `plan`) override the rest. `TURN_TIMEOUT_MS` (default 180000, `0` disables)
caps one turn — a turn that never finishes is interrupted and the session recovers.
No build step — Node ≥ 22.6 runs the `.ts`.

## Protocol

| Direction | Frame | Meaning |
|---|---|---|
| phone → server | binary | raw PCM Int16 LE, 16 kHz, mono |
| phone → server | text | `{"type":"mark","name","at"}` — a moment only the phone can see |
| phone → server | text | `{"type":"approve","text"?}` / `{"type":"reject"}` — decide a held instruction |
| server → phone | binary | raw PCM Int16 LE, 24 kHz, mono (Claude's voice) |
| server → phone | text | `{"type":"user"\|"model"\|"tool"\|"approval"\|"interrupted"\|"turn_end"\|"error","text"?}` |

`user` is the utterance as currently heard — it carries the whole thing each time and
replaces what came before, because the guess is revised while you speak; its `partial`
is false on the last one. `model` is Claude's answer as it is spoken and does join up,
`tool` names a tool Claude used, `approval` (review mode) offers a held instruction
for a yes/no, `turn_end` says the reply is finished — the only such signal.

Connect to `ws://<mac>:8765`. One `?mode=`: `direct` (default) runs each instruction
at once, `review` holds it for a spoken "yes"/"no" or an approve/reject frame first.
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
| `{"type":"voice_save","style"}` | … |
| `{"type":"chat_open","id"}` | that chat's messages |
| `{"type":"fork","id","at"}` | a new chat ending at message `at`, then opened |

Every message is answered with `{"type":"corrections","items":[…]}`,
`{"type":"voice","style":"…"}` and `{"type":"chats","chats":[…]}`, so the phone reads
what is there rather than tracking it. One chat's messages are the exception, sent
only when asked for, because they are the one part that is not small. `style` is put in front of every sentence the voice reads: the text-to-speech
API has no rate parameter, so the wording is the speed control — "Read this at a
brisk, quick pace" is about 1.5x faster than leaving it empty. It is stored in
`.voice.txt` and read per sentence, so a change is audible on the next one.

## What a turn leaves behind

Every finished turn is appended to `.turns.jsonl` as one line:

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
the reply, which is why measuring a turn needs no working output device.

## Run a primitive alone

```bash
node claude.ts "what is the latest commit"          # stream Claude's answer to stdout
node voice.ts  "Hello there. How are you?"          # write reply.pcm, print timings
node ears.ts   --file turn.wav                       # 16 kHz mono in → print partials, then the final
node probe.ts  "what is the latest commit"           # the whole path, no phone
node chats.ts                                        # list them; <id> prints one; fork <id> <uuid> branches
node import.ts ~/Downloads/conversation.json         # a conversation from elsewhere, as a chat
node lab.ts                                          # hold a Live session open and read its raw messages
```

`probe.ts` is the Mac half end to end: it connects like a phone, speaks, and prints
what Gemini heard and Claude said. The relay log proves the model strings and setup:
a wrong one dies in Node, never in Swift.
