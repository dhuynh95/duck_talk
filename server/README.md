# server/ — voice relay: phone ⇄ Gemini ⇄ Claude Code

The phone streams mic audio here; this server routes it through Gemini Live (as ears
and voice) and Claude Code (as the agent), and streams Claude's spoken answer back.
Four primitives, each runnable alone:

- `ears.ts`   — Gemini Live hearing: audio in → transcript, `converse`/`stop` tool calls, yes/no/stop words. Never speaks.
- `claude.ts` — Claude Code via the Agent SDK: one instruction → streamed text + tool calls + a session id to resume.
- `voice.ts`  — a second Gemini Live session as a streaming TTS: Claude's text in → 24 kHz PCM out.
- `session.ts`— the turn state machine wiring the three together, per phone connection.

```bash
cd server
npm install
npm start          # node --env-file-if-exists=../.env --watch server.ts  (port 8765)
```

Needs `GEMINI_API_KEY` and `ANTHROPIC_API_KEY` (or a logged-in `claude`) in the root
`.env` or the shell, and `claude` on PATH. `PROJECT_CWD` is the repo Claude works in
(default: the repo root). `GEMINI_MODEL`, `CLAUDE_MODEL`, `CLAUDE_PERMISSION_MODE`
(default `plan`) override the rest. No build step — Node ≥ 22.6 runs the `.ts`.

## Protocol

| Direction | Frame | Meaning |
|---|---|---|
| phone → server | binary | raw PCM Int16 LE, 16 kHz, mono |
| phone → server | text | `{"type":"mark","name","at"}` — a moment only the phone can see |
| phone → server | text | `{"type":"approve","text"?}` / `{"type":"reject"}` — decide a held instruction |
| phone → server | text | `{"type":"mute","on":bool}` — drop reply audio without stopping the turn |
| server → phone | binary | raw PCM Int16 LE, 24 kHz, mono (Claude's voice) |
| server → phone | text | `{"type":"user"\|"model"\|"tool"\|"approval"\|"interrupted"\|"turn_end"\|"error","text"?}` |

`user` is what Gemini heard, `model` is Claude's answer as it is spoken, `tool` names
a tool Claude used, `approval` (review mode) offers a held instruction for a yes/no,
`turn_end` says the reply is finished — the only such signal.

Connect to `ws://<mac>:8765`. Add `?echo=1` to get your own audio straight back
without touching Gemini — the phone-side smoke test. Add `?mode=review` to hold each
instruction: it is read back and offered for approval, and "yes"/"no" (spoken, or an
approve/reject frame) decides it. The default is direct — Claude runs at once.

## What a turn leaves behind

Every finished turn is appended to `.turns.jsonl` as one line:

```json
{"turn":1,"mode":"direct","heard":"What branch am I on?","instruction":"What branch am I on?",
 "approval":null,"said":"You're on main.","converse_at":1787900000000,"claude_first_at":1787900006146,
 "voice_out_at":1787900007000,"reply_in_at":1787900007001,"voice_ms":5630,"cost_usd":0.063}
```

Every timestamp is `Date.now()` on this Mac, where the phone (in the simulator), this
relay and the test harness all run, so a latency is a subtraction, never a
measurement. `converse_at → voice_out_at` is the whole wait a user sits through (now
Claude, not Gemini). `claude_first_at - converse_at` is Claude's own time — cold on
turn one, then resumed and fast. `voice_out_at → reply_in_at` is the cost of the hop.
`voice_ms` is exact: 24 kHz Int16 is 48 bytes per millisecond.

`app/sim.py`'s `play_audio` reads the last line of this file rather than listening to
the reply, which is why measuring a turn needs no working output device.

## Run a primitive alone

```bash
node claude.ts "what is the latest commit"          # stream Claude's answer to stdout
node voice.ts  "Hello there. How are you?"          # write reply.pcm, print timings
node ears.ts   --file turn.wav                       # 16 kHz mono in → print the events it routes
node probe.ts  "what is the latest commit"           # the whole path, no phone
```

`probe.ts` is the Mac half end to end: it connects like a phone, speaks, and prints
what Gemini heard and Claude said. The relay log proves the model strings and setup:
a wrong one dies in Node at `ears connected` / `voice connected`, never in Swift.
