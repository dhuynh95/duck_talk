# web/ — the browser client

The page the relay serves at `/`: plain ES modules and CSS that the browser loads as they
are. No build step, no bundler, no dependency. Types are JSDoc under `// @ts-check`, and
`tsc -p web` holds them to account inside `npm run check`. All of it ships in the package
except `tsconfig.json`, `env.d.ts` and this file (`files` in `package.json`).

For what it does, how to reach it and the access key, see the root
[`README.md`](../README.md#web-client).

## Run it and test it

```bash
npm start          # the relay; open an address it prints (a reload shows an edit)
npm test           # node --test over test/, which imports these modules in Node
npm run check      # tsc for server/ and for web/
node --test test/key.test.ts      # one file
```

## Map

| File | What it is |
|---|---|
| `main.js` | boot: the key (or the form that asks for it), then the app, wired together |
| `store.js` | one observable object: `get`, `set`, `subscribe` |
| `key.js` | the access key in the URL, in localStorage and at `/access.json`; the socket address |
| `settings.js` | what the pickers chose, kept in localStorage one field at a time |
| `dom.js` | `h()`, the only way an element is made, and its rules (below) |
| `session.js` | the chat socket: typing, talking, watching; backoff, outbox, `resume=` |
| `transcript.js` | the reducer over the relay's text frames: lines, tools, retract. No socket, no audio |
| `relay.js` | the `?data=1` socket: models, skills, chats, prompts, corrections; each clip and picture on a one-shot socket; a key the relay refuses, told apart from a relay that is down |
| `chat-flow.js` | what the data socket says about chats, carried onto the screen |
| `audio.js` | the Web Audio glue: microphone, speaker queue, chimes, echo gate, wake lock |
| `mic-worklet.js` | the AudioWorklet: microphone to 16 kHz Int16 frames. Not type-checked: its scope has other globals |
| `pcm.js`, `playback.js` | the audio path's arithmetic as plain functions: resampler, meter; what was heard, when to chime |
| `attach.js`, `intake.js` | picture to JPEG (long edge 1568 px, quality 0.8), the 800-character paste rule, and the queue that adds them |
| `skills.js`, `prompts.js`, `corrections.js` | the `/` filter, and the rules the two editors go by |
| `actions.js` | how one screen asks for another (a line's "Fix what was heard" opens the editor) |
| `ui/` | the screens and parts: header, transcript-view, composer (with attach-chips, skill-list, review-card, field), drawer, sheet, settings-menu, pickers, context-sheet, connection, key-form (the key form, on a first visit and as the "Key refused" dialog), prompts, corrections, line-actions, pieces, clip-chip, panes, icons |
| `index.html`, `style.css`, `manifest.webmanifest`, `logo.svg`, `chimes.wav` | what is served as it is |

## Rules to keep

- **Never `innerHTML`.** Nor `outerHTML`, `insertAdjacentHTML`, `document.write`,
  `createContextualFragment` or `parseFromString`: `test/no-innerhtml.test.ts` fails on them.
  The relay sends no Content-Security-Policy, so nothing stands behind this but the rule.
- **Untrusted text only as text.** The transcript, chat titles, tool names, corrections,
  skill descriptions and the relay's errors are somebody else's words. They reach the page
  as `textContent` or as a string child of `h()`, which makes a text node.
- **`h()` is strict.** It throws on a non-function `on…` prop, `srcdoc`, a string `style`,
  a URL attribute (`href`, `src`, `action`, …) that `safeUrl` refuses, and the tags
  `script`, `iframe`, `object`, `embed`, `base`, `meta`, `link` and `style`. Never pass
  data as a prop name. It skips props that are `false`, `null` or `undefined`, so an ARIA
  or enumerated attribute where absence is not `false` (`aria-pressed`, `aria-expanded`,
  `aria-checked`, `aria-selected`, `aria-hidden`, `draggable`, `spellcheck`,
  `contenteditable`) gets the string `'false'`.
- **Every module imports in Node.** No `window`, `document`, `localStorage` or
  `AudioContext` at import time, only inside functions: the tests import these files. The
  socket, the audio pipe, the timers and the clock are handed in, so a test can play them.
- **Storage can be missing.** Every touch of localStorage is in a try/catch, and the page
  works without it.
- The wire is the relay's: PCM Int16 LE, 16 kHz up and 24 kHz down, and JSON text frames
  as in [`server/README.md`](../server/README.md).
