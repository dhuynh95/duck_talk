/**
 * Voice relay: one WebSocket per phone, one Session behind it (ears + Claude + voice).
 *
 * Started by `cli.ts` in whatever folder you are standing in, and that folder is the
 * whole of the configuration — it is what Claude works in, so it decides which chats
 * exist, and it is where everything the relay learns is kept. See paths.ts.
 *
 *   ↑ binary  raw PCM Int16 LE, 16 kHz, mono          (mic)
 *   ↑ text    {"type":"text","text"}                  an instruction, typed
 *             {"type":"mark","name","at"}             a moment only the phone can see
 *             {"type":"approve","text"?}              run a held instruction, as edited
 *             {"type":"stop"}                         stop the running turn — the spoken "stop", as a button
 *             {"type":"claude","model"?,"permission"?,"effort"?} which model answers, what it may do, how hard it thinks
 *   ↓ binary  raw PCM Int16 LE, 24 kHz, mono          (Claude's voice)
 *   ↓ text    {"type":"user"|"model"|"tool"|"approval"|"turn_start"|"interrupted"|"turn_end"|"error","text"?}
 *             a `turn_start` is the instruction reaching Claude — the turn is running
 *             a `user` event also carries `partial`: true replaces the line, false ends it
 *             a `turn_end` carries `session`: which chat this connection is in
 *             a finished `user` carries `clip`: that utterance's audio, by id
 *             a `tool` carries `parent`: the Agent call it ran inside, null for Claude's own
 *             an `interrupted` may carry `retract`: the turn was taken back, un-show it
 *
 * Audio is what buys audio: the ears open on the first microphone buffer and the voice
 * speaks only where there are ears, so a connection that is only typed to reaches
 * Claude and never Gemini — with nothing in the URL saying which kind it is.
 *
 * A session is in one `?mode=`: `direct` (default) runs each instruction at once,
 * `review` holds it for a yes/no/edit first. Orthogonal to both, `?correct=1` has a
 * fast text model fix the instruction first, from the pairs a review-mode edit
 * taught (`.duck-talk/corrections.jsonl`). `?readback=1` also reads a held instruction aloud,
 * for deciding without looking at the screen. `?resume=<id>` carries on a past chat
 * instead of starting one — any session Claude Code has in this project, including
 * the ones you started in a terminal. A resumed chat whose Claude session is still
 * working is *attached to* rather than reopened — see claude.ts — and the running
 * turn's reply so far is replayed down the new socket before the rest streams live.
 * So a connection opened with `?resume=` and nothing to send is how the phone
 * watches a working chat: the same events as any turn, ending in `turn_end`.
 *
 * Which model answers, what it is allowed to do and how hard it thinks are deliberately
 * not in the URL: the CLI takes all three mid-session, so they arrive as a `claude`
 * frame whenever the phone opens a socket or changes its mind, and hold from the next
 * turn. Nothing reconnects to think differently.
 *
 * `?data=1` is a connection that reads and edits what the relay can see and nothing
 * else — the corrections, the prompts it says to each model, the models themselves, the
 * project's skills, and the chats — so the phone can show those screens with no voice
 * session running. Every message is answered with all of it, so the phone never has
 * to ask twice or guess what the files now say. The exceptions are the two parts that are not small: one chat's messages, sent
 * when asked for by `chat_open`, and one utterance's audio, sent as a binary frame
 * when asked for by `clip_get` — the only binary a data connection ever carries, so
 * there is nothing to tell apart. `fork` branches a chat at one message and answers
 * with the new one, which is `chat_open` on it; `chat_star`, `chat_rename` and
 * `chat_delete` answer with nothing of their own, because the list already says.
 * Each chat in the list carries `working`: Claude has work in flight there — a turn
 * being answered, or a background task still going. It is the one fact the store on
 * disk cannot say, and it changes on its own, so a fresh list is also pushed to every
 * open data connection the moment it does — see live.ts.
 *
 * Every finished turn is appended to `.duck-talk/turns.jsonl`. The phone, this relay and the
 * test harness all run on one Mac, so those timestamps share one clock and any
 * latency is a subtraction, never a measurement.
 */

import { WebSocketServer } from 'ws';
import { GoogleGenAI } from '@google/genai';
import { Session, type Mode, type Phone } from './session.ts';
import { billingMode, capabilities } from './claude.ts';
import { chat, chats, fork, remove as removeChat, rename, star } from './chats.ts';
import { read as readClip } from './clips.ts';
import { load, remove, save } from './corrections.ts';
import { watch, working } from './live.ts';
import { all as prompts, isName, write as writePrompt } from './prompts.ts';
import { reach } from './reach.ts';

const PORT = Number(process.env['PORT'] ?? 8765);
// Two jobs, two models: one Live session transcribes what you say, and a
// text-to-speech model reads Claude's answer back a sentence at a time. Only the
// first is a session — see voice.ts for why the reader is better off without one.
const STT_MODEL = process.env['STT_MODEL'] ?? 'gemini-3.5-transcribe-live';
const VOICE_MODEL = process.env['VOICE_MODEL'] ?? 'gemini-3.1-flash-tts-preview';
const API_KEY = process.env['GEMINI_API_KEY'];
if (!API_KEY) {
  console.error('GEMINI_API_KEY missing (set it in ../.env)');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: API_KEY });
const wss = new WebSocketServer({ port: PORT });
let nextId = 1;

// The chat list with the one fact only this process knows on it: which chats Claude
// is working in right now. Merged here rather than in chats.ts, because the store on
// disk cannot say it — see live.ts.
async function chatList() {
  const busy = working();
  return (await chats()).map((c) => ({ ...c, working: busy.has(c.id) }));
}

// The data connections held open right now — the drawer keeps one for as long as it
// is on screen. Told the moment the working set changes, so the pill on a chat
// appears and clears without the phone asking.
const dataConnections = new Set<import('ws').WebSocket>();
watch(() => {
  if (!dataConnections.size) return;
  void chatList().then((list) => {
    const frame = JSON.stringify({ type: 'chats', chats: list });
    for (const ws of dataConnections) if (ws.readyState === ws.OPEN) ws.send(frame);
  }).catch((e) => console.error(`chat list push failed: ${e}`));
});

wss.on('connection', (ws, req) => {
  const id = nextId++;
  const url = new URL(req.url ?? '/', 'ws://x');
  const asked = url.searchParams.get('mode');
  const mode: Mode = asked === 'review' ? 'review' : 'direct';
  const autocorrect = url.searchParams.get('correct') === '1';
  const readback = url.searchParams.get('readback') === '1';
  // A chat to carry on rather than start. The id came from this relay's own turn
  // records, so it is one Claude Code can resume in this `cwd`.
  const resume = url.searchParams.get('resume') ?? undefined;
  const log = (msg: string) => console.log(`[${id}] ${msg}`);
  log(`open (${mode}${autocorrect ? ', autocorrect' : ''}${readback ? ', readback' : ''}${resume ? `, resuming ${resume}` : ''})`);

  // `?data=1` edits what the relay owns and nothing else — no Gemini, no Claude — so
  // the phone can open those screens whether or not a session is live. Every message
  // is answered with all of it, so the phone never has to guess what the files say.
  if (url.searchParams.get('data') === '1') {
    dataConnections.add(ws);
    ws.on('message', async (raw, isBinary) => {
      if (isBinary) return;
      const f = parse(String(raw));
      if (f?.['type'] === 'correction_save') {
        const at = typeof f['at'] === 'number' ? f['at'] : Date.now();
        const heard = String(f['heard'] ?? '').trim();
        const meant = String(f['meant'] ?? '').trim();
        const clip = typeof f['clip'] === 'number' ? f['clip'] : undefined;
        if (heard && meant) { save({ at, heard, proposed: String(f['proposed'] ?? heard), meant, ...(clip ? { clip } : {}) }); log(`correction saved: ${heard} → ${meant}`); }
      } else if (f?.['type'] === 'correction_delete' && typeof f['at'] === 'number') {
        remove(f['at']);
        log(`correction deleted`);
      } else if (f?.['type'] === 'prompt_save' && isName(f['name'])) {
        writePrompt(f['name'], String(f['text'] ?? ''));
        log(`prompt saved: ${f['name']}`);
      } else if (f?.['type'] === 'chat_star' && typeof f['id'] === 'string') {
        const on = f['starred'] !== false;
        await star(f['id'], on);
        log(`${on ? 'starred' : 'unstarred'} ${f['id']}`);
      } else if (f?.['type'] === 'chat_rename' && typeof f['id'] === 'string' && typeof f['text'] === 'string') {
        await rename(f['id'], f['text']);
        log(`renamed ${f['id']}: ${f['text']}`);
      } else if (f?.['type'] === 'chat_delete' && typeof f['id'] === 'string') {
        await removeChat(f['id']);
        log(`deleted ${f['id']}`);
      }
      if (ws.readyState !== ws.OPEN) return;
      // The one thing here that is not text. Sent as the file, so the phone hands it
      // to a player rather than decoding anything — and asked for by id, so the list
      // stays small whether there are two clips or fifty.
      //
      // Before the state frames below, which is the whole answer to "was there one":
      // the first frame back is the audio, or it is text and there was none. Nothing
      // to count, nothing to wait out.
      if (f?.['type'] === 'clip_get' && typeof f['id'] === 'number') {
        const wav = readClip(f['id']);
        if (wav) ws.send(wav);
        else log(`clip ${f['id']} is gone`);
      }
      ws.send(JSON.stringify({ type: 'corrections', items: load() }));
      // Every prompt with its text, and with when it takes effect — so the phone can
      // grey out one it cannot usefully change without knowing what any of them are.
      ws.send(JSON.stringify({ type: 'prompts', prompts: prompts() }));
      // Which models this account may use, with the words to show for each — asked of
      // the CLI rather than written down here, the same rule the startup addresses
      // follow: the one process that knows, says. Remembered after the first ask, so
      // only the first data connection of a relay's life waits for it.
      const { models, skills } = await capabilities();
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({ type: 'models', models }));
      // The project's skills, for the composer's "/" autocomplete. The whole list every
      // time, like everything above: filtering as you type is the phone's own filter
      // over rows it already holds, never a question over the wire.
      ws.send(JSON.stringify({ type: 'skills', skills }));
      // Branching a chat has to happen before the list is sent, or the new one is
      // missing from the answer that reports it.
      let forked: string | null = null;
      if (f?.['type'] === 'fork' && typeof f['id'] === 'string' && typeof f['at'] === 'string') {
        try {
          forked = await fork(f['id'], f['at']);
          log(`forked ${f['id']} at ${f['at']} -> ${forked}`);
        } catch (e) {
          log(`fork failed: ${e}`);
        }
      }
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({ type: 'chats', chats: await chatList() }));
      // The list is small and always sent; a chat's messages are not, so they come
      // only when one is opened — or when a fork has just made one worth opening.
      const open = forked ?? (f?.['type'] === 'chat_open' && typeof f['id'] === 'string' ? f['id'] : null);
      if (open) {
        ws.send(JSON.stringify({ type: 'chat', id: open, messages: await chat(open), forked: forked !== null }));
      }
    });
    ws.on('close', () => { dataConnections.delete(ws); log('close'); });
    return;
  }

  const phone: Phone = {
    pcm: (buf) => { if (ws.readyState === ws.OPEN) ws.send(buf); },
    event: (msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); },
  };
  const session = new Session(phone, ai, mode, { sttModel: STT_MODEL, voiceModel: VOICE_MODEL, autocorrect, readback, resume }, log);

  ws.on('message', (data, isBinary) => {
    if (isBinary) session.send(data as Buffer);
    else { const f = parse(String(data)); if (f) session.frame(f); }
  });
  ws.on('close', () => { log('close'); void session.close().catch((e) => log(`close failed: ${e}`)); });

  try {
    session.open();
  } catch (e) {
    phone.event({ type: 'error', text: String(e) });
    log(`open failed: ${e}`);
    ws.close();
  }
});

// One session's bad moment must not disconnect every phone. Node exits on an
// uncaught error by default; here the connection that caused it is already broken,
// and the others are not, so log loudly and keep serving.
process.on('uncaughtException', (e) => console.error('uncaught:', e));
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e));

// Said when the port is actually held, not when it was asked for. Binding is
// asynchronous, and the failure that matters — someone else already on 8765, which is
// what a forgotten relay from this morning looks like — arrives after this line would
// otherwise have promised a server. The uncaught handler above would then swallow it
// and leave a process that answers nothing.
wss.on('listening', () => {
  // Where a phone can find this — every row the one process that knows can say, so
  // nobody copies an address out of System Settings or remembers a ts.net name.
  void reach(PORT).then((r) => {
    console.log(`  simulator    ${r.simulator}`);
    if (r.wifi) console.log(`  same Wi-Fi   ${r.wifi}`);
    console.log(`  anywhere     ${r.anywhere}`);
    console.log(`  stt ${STT_MODEL}  ·  voice ${VOICE_MODEL}`);
  });
  // Asking the CLI who it is takes a subprocess and about 700ms, so it is printed
  // when it comes back rather than kept in front of the address someone is waiting for.
  void billingMode().then((mode) => console.log(`  claude       ${mode}`));
});
wss.on('error', (e: NodeJS.ErrnoException) => {
  // Almost always a relay from earlier today, still up. Not stepped around: the phone
  // is pointed at this port — directly, or through a Tailscale door that opens onto
  // it — so a relay on another port is one the phone cannot reach.
  console.error(e.code === 'EADDRINUSE'
    ? `port ${PORT} is already taken — probably a relay you started earlier.\n  Stop it: lsof -ti tcp:${PORT} -sTCP:LISTEN | xargs kill`
    : `could not listen on ${PORT}: ${e.message}`);
  process.exit(1);
});

function parse(text: string): Record<string, unknown> | null {
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; }
}
