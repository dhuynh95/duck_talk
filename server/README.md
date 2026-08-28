# server/ — minimal relay between the phone and Gemini Live

The phone streams mic audio to this server; the server holds the Gemini Live
session and streams the voice back. No Claude, no tools — this exists to measure
whether relaying audio through the Mac is fast enough. The full server in `src/`
is untouched.

```bash
cd server
npm install
npm start          # node --env-file-if-exists=../.env --watch server.ts  (port 8765)
```

Needs `GEMINI_API_KEY` in the repo-root `.env`. `GEMINI_MODEL` overrides the model
(default `gemini-3.1-flash-live-preview`). No build step — Node ≥ 22.6 runs the
`.ts` directly.

## Protocol

| Direction | Frame | Meaning |
|---|---|---|
| phone → server | binary | raw PCM Int16 LE, 16 kHz, mono |
| phone → server | text | `{"type":"mark","name":string,"at":epoch ms}` — a moment only the phone can see |
| server → phone | binary | raw PCM Int16 LE, 24 kHz, mono |
| server → phone | text | `{"type":"user"\|"model"\|"interrupted"\|"turn_end"\|"error","text"?:string}` |

`user` and `model` are transcript fragments, `turn_end` says the reply is finished —
the only such signal, so a client that ignores it has to guess with a timer.

Connect to `ws://<mac>:8765`. Add `?echo=1` to get your own audio straight back
without touching Gemini — the phone-side smoke test. Echoed audio was captured at
16 kHz and plays at 24 kHz, so you hear yourself 1.5× fast; that's expected.

## What a turn leaves behind

Every finished turn is appended to `.turns.jsonl` as one line:

```json
{"turn":2,"heard":"What is the capital of France?","said":"The capital of France is Paris...",
 "reply_out_at":1787896371516,"reply_in_at":1787896371517,"voice_ms":4760.6}
```

`reply_out_at` is when this relay wrote the first reply byte; `reply_in_at` is when
the phone said it arrived, marked by the phone itself. Both are `Date.now()` on this
Mac — the simulator runs here too — so the difference is the cost of the hop, with
nothing to synchronise. `voice_ms` is exact: 24 kHz Int16 is 48 bytes per millisecond.

`app/sim.py`'s `play_audio` reads the last line of this file rather than listening to
the reply, which is why measuring a turn needs no working output device.

## Try it without a phone

```bash
node -e "const w=new WebSocket('ws://localhost:8765');w.onopen=()=>setTimeout(()=>w.close(),3000)"
```

The server log should show `gemini connected`. If the model name or setup shape is
wrong, this is where it says so.
