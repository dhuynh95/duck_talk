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
| server → phone | binary | raw PCM Int16 LE, 24 kHz, mono |
| server → phone | text | `{"type":"user"\|"model"\|"interrupted"\|"error","text"?:string}` |

Connect to `ws://<mac>:8765`. Add `?echo=1` to get your own audio straight back
without touching Gemini — the phone-side smoke test. Echoed audio was captured at
16 kHz and plays at 24 kHz, so you hear yourself 1.5× fast; that's expected.

## Try it without a phone

```bash
node -e "const w=new WebSocket('ws://localhost:8765');w.onopen=()=>setTimeout(()=>w.close(),3000)"
```

The server log should show `gemini connected`. If the model name or setup shape is
wrong, this is where it says so.
