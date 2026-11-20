import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createStore } from '../web/store.js';
import { RelayStore } from '../web/relay.js';
import { modelLabel } from '../web/ui/pickers.js';

// The data socket is handed its socket and its timers, so a test plays the relay by hand: it
// opens and drops sockets, answers frames the way server.ts does, and moves time.

class FakeSocket {
  url: string;
  sent: string[] = [];
  readyState = 0;
  binaryType = 'blob';
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  /** Called with each frame as it is sent, so a test can look at the world at that moment. */
  spy: ((frame: any) => void) | null = null;
  constructor(url: string) {
    this.url = url;
  }
  send(data: string) {
    if (this.readyState !== 1) throw new Error('send on a socket that is not open');
    this.sent.push(data);
    this.spy?.(JSON.parse(data));
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(obj: unknown) {
    this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) });
  }
  receiveBinary(bytes: number[]) {
    this.onmessage?.({ data: new Uint8Array(bytes).buffer });
  }
  /** What server.ts sends after every request: all the state, the chat list last. */
  burst(extra: { chats?: unknown[]; items?: unknown[]; models?: unknown[] } = {}) {
    this.receive({ type: 'corrections', items: extra.items ?? [] });
    this.receive({ type: 'prompts', prompts: [] });
    this.receive({ type: 'models', models: extra.models ?? [] });
    this.receive({ type: 'skills', skills: [] });
    this.receive({ type: 'chats', chats: extra.chats ?? [] });
  }
  /** Closed by the store. */
  close() {
    this.drop();
  }
  /** Dropped from the far end. */
  drop() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({});
  }
  get frames() {
    return this.sent.map((d) => JSON.parse(d));
  }
}

function rig(opts: { dialThrows?: () => boolean } = {}) {
  let time = 1_000_000;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const sockets: FakeSocket[] = [];
  const store = createStore<Record<string, any>>({});
  const relay = new RelayStore({
    store,
    urlFor: () => 'ws://relay/?data=1',
    makeSocket: (url: string) => {
      if (opts.dialThrows?.()) throw new SyntaxError("Failed to construct 'WebSocket': The URL is invalid.");
      const s = new FakeSocket(url);
      sockets.push(s);
      return s as any;
    },
    setTimer: (fn: () => void, ms: number) => {
      const t = { at: time + ms, fn, live: true };
      timers.push(t);
      return () => void (t.live = false);
    },
  });
  const advance = (ms: number) => {
    const end = time + ms;
    for (;;) {
      const next = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.live = false;
      time = Math.max(time, next.at);
      next.fn();
    }
    time = end;
  };
  const last = () => sockets.at(-1)!;
  /** A relay that has answered `read`: the usual state of a page that has been up for a moment. */
  const up = () => {
    relay.connect();
    last().open();
    last().receive({ type: 'relay', version: '1.2.3' });
    last().burst();
    return last();
  };
  return { relay, store, state: () => store.get(), sockets, advance, last, up };
}

const bytes = async (blob: Blob) => [...new Uint8Array(await blob.arrayBuffer())];
const tick = () => new Promise((r) => setImmediate(r));

describe('RelayStore: connecting', () => {
  it('dials the data address, is not connected until a frame comes back, and asks for everything on open', () => {
    const { relay, state, sockets, last } = rig();
    relay.connect();
    assert.equal(sockets.length, 1);
    assert.equal(last().url, 'ws://relay/?data=1');
    assert.equal(last().binaryType, 'arraybuffer');
    assert.equal(state()['connected'], false);
    last().open();
    assert.deepEqual(last().frames, [{ type: 'read' }]);
    assert.equal(state()['connected'], false, 'an open socket is proof of a port, not of a relay');
  });

  it('dials once however often it is asked', () => {
    const { relay, sockets } = rig();
    relay.connect();
    relay.connect();
    assert.equal(sockets.length, 1);
  });

  it('a relay frame sets connected and relayVersion', () => {
    const { relay, state, last } = rig();
    relay.connect();
    last().open();
    last().receive({ type: 'relay', version: '1.0.1' });
    assert.equal(state()['connected'], true);
    assert.equal(state()['relayVersion'], '1.0.1');
  });

  it('stores corrections newest first, because the relay sends oldest first', () => {
    const { state, up } = rig();
    up().receive({ type: 'corrections', items: [{ at: 1, heard: 'a', meant: 'A' }, { at: 2, heard: 'b', meant: 'B' }, { at: 3, heard: 'c', meant: 'C' }] });
    assert.deepEqual(state()['corrections'].map((c: any) => c.at), [3, 2, 1]);
  });

  it('stores prompts, models, skills and chats as they arrive', () => {
    const { state, up } = rig();
    const s = up();
    s.receive({ type: 'prompts', prompts: [{ name: 'voice', title: 'Voice', detail: 'd', live: true, text: 't' }] });
    s.receive({ type: 'models', models: [{ value: 'default', displayName: 'Default', description: '' }] });
    s.receive({ type: 'skills', skills: [{ name: 'review', description: 'd', argumentHint: '' }] });
    s.receive({ type: 'chats', chats: [{ id: 'x', at: 1, title: 'T' }] });
    assert.equal(state()['prompts'][0].name, 'voice');
    assert.equal(state()['models'][0].value, 'default');
    assert.equal(state()['skills'][0].name, 'review');
    assert.equal(state()['chats'][0].id, 'x');
  });

  it('ignores a frame that is not JSON, and JSON that is not a frame, without saying a relay is there', () => {
    const { relay, state, last } = rig();
    relay.connect();
    last().open();
    last().receive('{not json');
    last().receive('null');
    last().receive('7');
    last().receive('[1,2]');
    assert.equal(state()['connected'], false);
    assert.equal(state()['corrections'], undefined);
  });

  it('takes a frame of a type it does not know as proof of a relay, and keeps what it has', () => {
    const { state, up } = rig();
    const s = up();
    s.receive({ type: 'chats', chats: [{ id: 'x', at: 1, title: 'T' }] });
    s.receive({ type: 'from-the-future', whatever: 1 });
    assert.equal(state()['connected'], true);
    assert.equal(state()['chats'].length, 1);
  });

  it('ignores a field of the wrong shape rather than storing it', () => {
    const { state, up } = rig();
    const s = up();
    s.receive({ type: 'models', models: [{ value: 'a', displayName: 'A', description: '' }] });
    s.receive({ type: 'models', models: 'not a list' });
    assert.equal(state()['models'].length, 1);
  });
});

describe('RelayStore: rows that cannot be drawn are not stored', () => {
  const good = { value: 'sonnet', displayName: 'Sonnet', description: 'fast' };

  it('keeps `models` undefined until the relay has answered, and an empty list is an answer', () => {
    const { relay, state, last } = rig();
    relay.connect();
    last().open();
    assert.equal(state()['models'], undefined, 'not yet');
    last().receive({ type: 'models', models: [] });
    assert.deepEqual(state()['models'], [], 'none, which is not the same as not yet');
  });

  it('drops a model row that is not an object, or has no string value, and keeps the good ones in order', () => {
    const { state, up } = rig();
    up().receive({ type: 'models', models: [null, 'sonnet', 7, [], {}, { value: 5 }, { value: null }, good, { value: 'haiku', displayName: 'Haiku', description: '' }] });
    assert.deepEqual(state()['models'].map((m: any) => m.value), ['sonnet', 'haiku']);
  });

  it('drops a model row whose optional fields are of a type that would break drawing it', () => {
    const { state, up } = rig();
    up().receive({
      type: 'models',
      models: [
        { value: 'a', resolvedModel: 5 },
        { value: 'b', supportedEffortLevels: 'high' },
        { value: 'c', supportedEffortLevels: ['low', 3] },
        { value: 'd', displayName: { text: 'D' } },
        { value: 'e', description: 4 },
        { value: 'ok', resolvedModel: 'claude-opus-5', supportedEffortLevels: ['low', 'high'], supportsEffort: true },
        { value: 'plain' },
      ],
    });
    assert.deepEqual(state()['models'].map((m: any) => m.value), ['ok', 'plain']);
  });

  it('a list of nothing but bad rows is an empty list, which the page words as "none", not as "loading"', () => {
    const { state, up } = rig();
    up().receive({ type: 'models', models: [null, {}] });
    assert.deepEqual(state()['models'], []);
  });

  it('a malformed row cannot make the label throw inside the store write', () => {
    const { store, up } = rig();
    const labels: string[] = [];
    store.subscribe((state) => labels.push(modelLabel(state['models'], 'sonnet')));
    up().receive({ type: 'models', models: [{ value: 'x', resolvedModel: 5 }, null, good] });
    assert.equal(labels.at(-1), 'Sonnet');
  });

  it('drops corrections without a numeric at or without text on both sides, and still lists newest first', () => {
    const { state, up } = rig();
    up().receive({
      type: 'corrections',
      items: [{ at: 1, heard: 'a', meant: 'A' }, null, { at: 'x', heard: 'b', meant: 'B' }, { at: 2, heard: 'b' }, { at: 3, meant: 'C' }, { at: 4, heard: 'd', meant: 'D', clip: 'not a number' }, { at: 5, heard: 'e', meant: 'E', clip: 9 }],
    });
    assert.deepEqual(state()['corrections'].map((c: any) => c.at), [5, 1]);
  });

  it('drops prompts without a name, title and text', () => {
    const { state, up } = rig();
    up().receive({
      type: 'prompts',
      prompts: [
        { name: 'voice', title: 'Voice', detail: 'd', live: true, text: 't' },
        'voice',
        { title: 'T', text: 't' },
        { name: 'x', text: 't' },
        { name: 'y', title: 'Y' },
        { name: 'z', title: 'Z', text: 't', detail: 5 },
        { name: 'claude', title: 'Claude', detail: '', live: false, text: '' },
      ],
    });
    assert.deepEqual(state()['prompts'].map((p: any) => p.name), ['voice', 'claude']);
  });

  it('drops skills without a string name, and chats without a string id', () => {
    const { state, up } = rig();
    const s = up();
    s.receive({ type: 'skills', skills: [{ name: 'review', description: 'd', argumentHint: '' }, { description: 'nameless' }, { name: 7 }, null, { name: 'x', description: [] }] });
    s.receive({ type: 'chats', chats: [{ id: 'a', at: 1, title: 'A' }, { at: 2, title: 'no id' }, { id: 3, at: 3 }, 'b', { id: 'c', at: 'yesterday' }, { id: 'd', at: 4, title: 'D', starred: true }] });
    assert.deepEqual(state()['skills'].map((k: any) => k.name), ['review']);
    assert.deepEqual(state()['chats'].map((c: any) => c.id), ['a', 'd'], 'order as sent, newest first');
  });

  it('a frame whose every row is bad replaces the list with an empty one, and is still proof of a relay', () => {
    const { state, up } = rig();
    const s = up();
    s.receive({ type: 'chats', chats: [{ id: 'a', at: 1, title: 'A' }] });
    s.receive({ type: 'chats', chats: [{ at: 1 }] });
    assert.equal(state()['connected'], true);
    assert.deepEqual(state()['chats'], []);
  });
});

describe('RelayStore: losing and finding the relay again', () => {
  it('says connected is false the moment the socket goes, with a reason, and a frame clears it', () => {
    const { state, sockets, last, advance, up } = rig();
    up().drop();
    assert.equal(state()['connected'], false);
    assert.equal(typeof state()['relayError'], 'string');
    advance(250);
    assert.equal(sockets.length, 2);
    last().open();
    last().receive({ type: 'relay', version: '1' });
    assert.equal(state()['connected'], true);
    assert.equal(state()['relayError'], null);
  });

  it('redials after 250 ms, then 500, doubling to 5 s while connections keep failing', () => {
    const { relay, sockets, last, advance } = rig();
    relay.connect();
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      last().drop();
      const before = sockets.length;
      let waited = 0;
      while (sockets.length === before && waited < 10_000) {
        advance(50);
        waited += 50;
      }
      waits.push(waited);
    }
    assert.deepEqual(waits, [250, 500, 1000, 2000, 4000, 5000, 5000]);
  });

  it('starts over at 250 ms once a connection has lasted more than 5 s', () => {
    const { relay, sockets, last, advance } = rig();
    relay.connect();
    last().drop(); // 250
    advance(250);
    last().drop(); // 500
    advance(500);
    last().open();
    last().receive({ type: 'relay', version: '1' });
    advance(5001);
    last().drop();
    advance(249);
    assert.equal(sockets.length, 3, 'not yet');
    advance(1);
    assert.equal(sockets.length, 4, 'back at 250 ms, not 1 s');
  });

  it('does not start over for a connection that dropped inside 5 s', () => {
    const { relay, sockets, last, advance } = rig();
    relay.connect();
    last().drop();
    advance(250);
    last().open();
    advance(4000);
    last().drop();
    advance(499);
    assert.equal(sockets.length, 2);
    advance(1);
    assert.equal(sockets.length, 3, 'the second wait, 500 ms');
  });

  it('disconnect closes the socket, says not connected, and never redials', () => {
    const { relay, state, sockets, advance, up } = rig();
    up();
    relay.disconnect();
    assert.equal(state()['connected'], false);
    advance(60_000);
    assert.equal(sockets.length, 1);
  });

  it('connect after disconnect dials again from the first backoff', () => {
    const { relay, sockets, last, advance } = rig();
    relay.connect();
    last().drop();
    advance(250);
    last().drop();
    relay.disconnect();
    relay.connect();
    assert.equal(sockets.length, 3);
    last().drop();
    advance(250);
    assert.equal(sockets.length, 4);
  });

  it('ignores whatever an old socket says after it was replaced', () => {
    const { state, sockets, advance, up } = rig();
    const old = up();
    old.drop();
    advance(250);
    sockets[1]!.open();
    old.receive({ type: 'chats', chats: [{ id: 'ghost', at: 1, title: 'x' }] });
    assert.deepEqual(state()['chats'], []);
  });
});

describe('RelayStore: frames out', () => {
  const cases: [string, (r: RelayStore) => void, object][] = [
    ['saveCorrection', (r) => r.saveCorrection({ at: 5, heard: 'h', meant: 'm' }), { type: 'correction_save', at: 5, heard: 'h', meant: 'm' }],
    ['saveCorrection with its clip and proposal', (r) => r.saveCorrection({ at: 5, heard: 'h', meant: 'm', clip: 9, proposed: 'p' }), { type: 'correction_save', at: 5, heard: 'h', meant: 'm', clip: 9, proposed: 'p' }],
    ['deleteCorrection', (r) => r.deleteCorrection(5), { type: 'correction_delete', at: 5 }],
    ['savePrompt', (r) => r.savePrompt('voice', 'speak slowly'), { type: 'prompt_save', name: 'voice', text: 'speak slowly' }],
    ['fork', (r) => r.fork('c1', 'uuid-3'), { type: 'fork', id: 'c1', at: 'uuid-3' }],
    ['star', (r) => r.star('c1', true), { type: 'chat_star', id: 'c1', starred: true }],
    ['unstar', (r) => r.star('c1', false), { type: 'chat_star', id: 'c1', starred: false }],
    ['rename', (r) => r.rename('c1', 'New name'), { type: 'chat_rename', id: 'c1', text: 'New name' }],
    ['deleteChat', (r) => r.deleteChat('c1'), { type: 'chat_delete', id: 'c1' }],
  ];
  for (const [name, call, frame] of cases) {
    it(`${name} sends ${JSON.stringify(frame)}`, () => {
      const { relay, up } = rig();
      const s = up();
      call(relay);
      assert.deepEqual(s.frames.at(-1), frame);
    });
  }

  it('says nothing while there is no open socket, and queues nothing for the next one', () => {
    const { relay, last } = rig();
    relay.connect();
    relay.saveCorrection({ at: 1, heard: 'a', meant: 'b' });
    last().open();
    assert.deepEqual(last().frames, [{ type: 'read' }]);
  });
});

describe('RelayStore: chats', () => {
  it('forgets the loaded chat before asking for one, and a chat frame sets it', () => {
    const { relay, state, up } = rig();
    const s = up();
    let loadedWhenSent: unknown = 'not sent';
    s.spy = (frame) => {
      if (frame.type === 'chat_open') loadedWhenSent = state()['loaded'];
    };
    relay.openChat('c1');
    assert.equal(loadedWhenSent, null);
    s.receive({ type: 'chat', id: 'c1', messages: [{ uuid: 'u', role: 'user', text: 'hi' }], forked: false });
    assert.deepEqual(state()['loaded'], { id: 'c1', messages: [{ uuid: 'u', role: 'user', text: 'hi' }], forked: false });
  });

  it('makes reopening the same chat a change: the store is told null, then the chat', () => {
    const { relay, store, up } = rig();
    const s = up();
    s.receive({ type: 'chat', id: 'c1', messages: [], forked: false });
    const seen: unknown[] = [];
    store.subscribe((state) => seen.push(state['loaded']));
    relay.openChat('c1');
    s.receive({ type: 'chat', id: 'c1', messages: [{ uuid: 'u', role: 'user', text: 'again' }], forked: false });
    assert.equal(seen.length, 2);
    assert.equal(seen[0], null);
    assert.equal((seen[1] as any).id, 'c1');
    assert.equal((seen[1] as any).messages.length, 1);
  });

  it('tells a fork from an open: the chat frame says forked', () => {
    const { relay, state, up } = rig();
    const s = up();
    relay.fork('c1', 'u9');
    s.receive({ type: 'chat', id: 'c2', messages: [], forked: true });
    assert.equal(state()['loaded'].forked, true);
    assert.equal(state()['loaded'].id, 'c2');
  });

  it('forgets the loaded chat even when it cannot ask, so the screen is never left on the old one', () => {
    const { relay, state, last } = rig();
    relay.connect();
    last().receive({ type: 'chat', id: 'c1', messages: [], forked: false });
    relay.openChat('c1');
    assert.equal(state()['loaded'], null);
  });
});

// Media is asked for on a socket of its own, as the phone does (Relay.ask): a clip or a picture is
// one question and one binary frame back, and the relay answers it AHEAD of the state frames every
// message gets. On the page's one data socket that cannot be told from the chat list the relay
// pushes to every data connection whenever a chat starts or stops working: see the first test.
describe('RelayStore: clips and images', () => {
  const asked = (s: FakeSocket) => s.frames.filter((f) => f.type === 'clip_get' || f.type === 'image_get');
  /** A request whose promise is watched, so a test can say "not yet". */
  const watched = <T>(p: Promise<T>) => {
    const out = { done: false, value: undefined as T | undefined };
    void p.then(
      (v) => {
        out.done = true;
        out.value = v;
      },
      () => {
        out.done = true; // refused is an answer to "not yet" too
      },
    );
    return out;
  };

  it('a chat list pushed while a clip is being asked for is not taken for the answer, and the audio is not handed to the next request', async () => {
    const { relay, sockets, up } = rig();
    up();
    const first = relay.clip(1);
    const second = relay.image(2);
    const [a, b] = [sockets[1]!, sockets[2]!];
    a.open();
    b.open();
    // The relay pushes a fresh chat list to every data connection when a chat's working status
    // changes. Here it lands on both sockets between the request and the relay's answer.
    a.receive({ type: 'chats', chats: [] });
    b.receive({ type: 'chats', chats: [] });
    a.receiveBinary([1, 1, 1]); // clip 1's own audio, which the relay did have
    a.burst();
    b.receiveBinary([2, 2]);
    b.burst();
    assert.deepEqual(await bytes((await first)!), [1, 1, 1]);
    assert.deepEqual(await bytes((await second)!), [2, 2]);
  });

  it('asks on a socket of its own, at the data address, and says nothing on the data socket', () => {
    const { relay, sockets, up } = rig();
    const data = up();
    void relay.clip(7);
    assert.equal(sockets.length, 2);
    const shot = sockets[1]!;
    assert.equal(shot.url, 'ws://relay/?data=1');
    assert.equal(shot.binaryType, 'arraybuffer');
    assert.deepEqual(shot.frames, [], 'nothing is said until the socket is open');
    shot.open();
    assert.deepEqual(shot.frames, [{ type: 'clip_get', id: 7 }]);
    assert.deepEqual(asked(data), []);
  });

  it('resolves with the first binary frame as audio/wav, once it is past the relay\'s greeting, and lets the socket go', async () => {
    const { relay, sockets, up } = rig();
    up();
    const clip = relay.clip(7);
    const shot = sockets[1]!;
    shot.open();
    shot.receive({ type: 'relay', version: '1.2.3' });
    const pending = watched(clip);
    await tick();
    assert.equal(pending.done, false, 'the greeting is not an answer');
    shot.receiveBinary([82, 73, 70, 70]);
    const blob = await clip;
    assert.ok(blob);
    assert.equal(blob.type, 'audio/wav');
    assert.deepEqual(await bytes(blob), [82, 73, 70, 70]);
    assert.equal(shot.readyState, 3, 'closed: nothing more is wanted from it');
  });

  it('resolves an image with a JPEG', async () => {
    const { relay, sockets, up } = rig();
    up();
    const image = relay.image(3);
    const shot = sockets[1]!;
    shot.open();
    assert.deepEqual(shot.frames, [{ type: 'image_get', id: 3 }]);
    shot.receiveBinary([255, 216, 255]);
    const blob = await image;
    assert.equal(blob?.type, 'image/jpeg');
    assert.deepEqual(await bytes(blob!), [255, 216, 255]);
  });

  it('resolves null for a clip that is gone: the answer starts with the state frames, corrections first', async () => {
    const { relay, sockets, up } = rig();
    up();
    const clip = relay.clip(7);
    const shot = sockets[1]!;
    shot.open();
    shot.receive({ type: 'relay', version: '1' });
    shot.receive({ type: 'corrections', items: [] });
    assert.equal(await clip, null);
    assert.equal(shot.readyState, 3);
  });

  it('a chat list pushed ahead of a missing file\'s state frames is not a second answer, and one pushed ahead of the audio is not the answer', async () => {
    const { relay, sockets, up } = rig();
    up();
    const gone = relay.clip(1);
    const there = relay.clip(2);
    sockets[1]!.open();
    sockets[2]!.open();
    sockets[1]!.receive({ type: 'chats', chats: [] }); // a push
    const early = watched(gone);
    await tick();
    assert.equal(early.done, false, 'a push is nobody\'s answer');
    sockets[1]!.burst(); // the answer: corrections first, so there was no file
    assert.equal(await gone, null);

    sockets[2]!.receive({ type: 'chats', chats: [] }); // a push ahead of the audio
    sockets[2]!.receiveBinary([9]);
    assert.deepEqual(await bytes((await there)!), [9]);
  });

  it('what the data socket hears cannot answer a request made on another socket', async () => {
    const { relay, sockets, up } = rig();
    const data = up();
    const clip = relay.clip(1);
    const shot = sockets[1]!;
    shot.open();
    data.receiveBinary([5, 5, 5]); // nobody asked the data socket for audio
    data.burst(); // the answer to a star sent a moment before, say
    const pending = watched(clip);
    await tick();
    assert.equal(pending.done, false);
    shot.receiveBinary([1]);
    assert.deepEqual(await bytes((await clip)!), [1]);
  });

  it('answers two requests each with its own bytes, whichever socket answers first', async () => {
    const { relay, sockets, up } = rig();
    up();
    const first = relay.clip(1);
    const second = relay.image(2);
    sockets[1]!.open();
    sockets[2]!.open();
    sockets[2]!.receiveBinary([2, 2]);
    sockets[1]!.receiveBinary([1, 1]);
    assert.deepEqual(await bytes((await second)!), [2, 2]);
    assert.deepEqual(await bytes((await first)!), [1, 1]);
  });

  it('asks on at most three sockets at once, and opens the next as one of them finishes', async () => {
    const { relay, sockets, up } = rig();
    up();
    const all = [1, 2, 3, 4, 5].map((id) => relay.image(id));
    assert.equal(sockets.length, 1 + 3, 'the data socket and three');
    sockets[1]!.open();
    sockets[1]!.receiveBinary([1]);
    assert.deepEqual(await bytes((await all[0])!), [1]);
    assert.equal(sockets.length, 1 + 4, 'the fourth starts as the first ends');
    sockets[4]!.open();
    assert.deepEqual(sockets[4]!.frames, [{ type: 'image_get', id: 4 }], 'in the order they were asked');
    sockets[4]!.receiveBinary([4]);
    sockets[2]!.open();
    sockets[2]!.receive({ type: 'corrections', items: [] });
    assert.equal(await all[1], null);
    assert.equal(sockets.length, 1 + 5);
    assert.deepEqual(await bytes((await all[3])!), [4]);
    sockets[3]!.open();
    sockets[3]!.receiveBinary([3]);
    sockets[5]!.open();
    sockets[5]!.receiveBinary([5]);
    assert.deepEqual(await bytes((await all[2])!), [3]);
    assert.deepEqual(await bytes((await all[4])!), [5]);
  });

  // A request ends one of two ways. The relay answered: a file, or null for "no file here" — a fact
  // about the relay that stays true. Or it could not be asked, or did not say: a rejection with a
  // sentence a person can read, which is about this moment and must never be taken for the first.
  it('a socket that is refused or closes before it answers rejects, with why, and the next request still goes out', async () => {
    const { relay, sockets, up } = rig();
    up();
    const reqs = [1, 2, 3, 4].map((id) => relay.clip(id));
    const settled = Promise.allSettled(reqs.slice(0, 2));
    sockets[1]!.onerror?.({});
    sockets[1]!.drop();
    sockets[2]!.open();
    sockets[2]!.drop();
    const [refused, dropped] = await settled;
    assert.equal(refused?.status, 'rejected');
    assert.equal((refused as PromiseRejectedResult).reason.message, 'Could not reach the relay.');
    assert.ok((refused as PromiseRejectedResult).reason instanceof Error);
    assert.equal(dropped?.status, 'rejected');
    assert.equal((dropped as PromiseRejectedResult).reason.message, 'The connection to the relay was lost.');
    assert.equal(sockets.length, 1 + 4, 'both slots were given to the next two');
    assert.deepEqual(sockets[4]!.frames, []);
    sockets[3]!.open();
    sockets[3]!.receiveBinary([3]);
    assert.deepEqual(await bytes((await reqs[2])!), [3]);
  });

  it('a socket error is a failure on its own, without waiting for a close that may be a while coming', async () => {
    const { relay, sockets, up } = rig();
    up();
    const clip = relay.clip(1);
    sockets[1]!.open();
    sockets[1]!.onerror?.({});
    await assert.rejects(clip, { message: 'The connection to the relay was lost.' });
    assert.equal(sockets[1]!.readyState, 3, 'and the socket is let go of');
  });

  it('an address the browser will not dial rejects too: the relay was not asked', async () => {
    let throws = false;
    const { relay, up } = rig({ dialThrows: () => throws });
    up();
    throws = true;
    await assert.rejects(relay.image(1), { message: 'Could not reach the relay.' });
  });

  it('gives up after 10 s with a rejection, closes the socket, and goes on to the next request', async () => {
    const { relay, sockets, advance, up } = rig();
    up();
    const reqs = [1, 2, 3, 4].map((id) => relay.clip(id));
    const settled = Promise.allSettled(reqs.slice(0, 3)); // the three that had a socket, all asked at the same moment
    sockets[1]!.open();
    advance(9_999);
    const stuck = watched(reqs[0]!);
    await tick();
    assert.equal(stuck.done, false);
    advance(1);
    const [result] = await settled;
    assert.equal(result?.status, 'rejected', 'a relay that says nothing has not said there is no file');
    assert.equal((result as PromiseRejectedResult).reason.message, 'The relay did not answer in time.');
    assert.equal(sockets[1]!.readyState, 3, 'a late answer on it can never be taken for another');
    assert.equal(sockets.length, 1 + 4, 'the fourth request now has its socket');
  });

  it('a failure is not remembered: the same id asked for again is a new question, and may be answered', async () => {
    const { relay, sockets, advance, up } = rig();
    up();
    const first = relay.clip(7);
    sockets[1]!.open();
    advance(10_000);
    await assert.rejects(first, { message: 'The relay did not answer in time.' });

    const again = relay.clip(7);
    assert.equal(sockets.length, 1 + 2, 'a socket of its own, not the failed answer handed back');
    sockets[2]!.open();
    assert.deepEqual(sockets[2]!.frames, [{ type: 'clip_get', id: 7 }]);
    sockets[2]!.receiveBinary([82, 73]);
    assert.deepEqual(await bytes((await again)!), [82, 73]);
  });

  it('and a definite "no file" is not a failure: null, and asking again is answered the same way', async () => {
    const { relay, sockets, up } = rig();
    up();
    const first = relay.image(9);
    sockets[1]!.open();
    sockets[1]!.burst();
    assert.equal(await first, null);
    const second = relay.image(9);
    sockets[2]!.open();
    sockets[2]!.burst();
    assert.equal(await second, null);
  });

  it('does not time out a request that was answered, and does not let the data socket go', async () => {
    const { relay, sockets, advance, up } = rig();
    const data = up();
    const clip = relay.clip(1);
    sockets[1]!.open();
    sockets[1]!.receiveBinary([1]);
    assert.ok(await clip);
    advance(60_000);
    assert.equal(sockets.length, 2, 'no redial: the data socket was never touched');
    assert.equal(data.readyState, 1);
  });

  it('ignores whatever a socket says after its request was settled', async () => {
    const { relay, sockets, up } = rig();
    up();
    const first = relay.clip(1);
    const second = relay.clip(2);
    const [a, b] = [sockets[1]!, sockets[2]!];
    a.open();
    b.open();
    a.receiveBinary([1]);
    await first;
    a.receiveBinary([9, 9]); // late
    a.receive({ type: 'corrections', items: [] });
    b.receiveBinary([2]);
    assert.deepEqual(await bytes((await second)!), [2]);
  });

  it('disconnect rejects what is outstanding and what is queued, closes the sockets, and asks nothing more', async () => {
    const { relay, sockets, up } = rig();
    up();
    const reqs = [1, 2, 3, 4].map((id) => relay.clip(id));
    const settled = Promise.allSettled(reqs);
    sockets[1]!.open();
    relay.disconnect();
    for (const r of await settled) {
      assert.equal(r.status, 'rejected');
      assert.equal((r as PromiseRejectedResult).reason.message, 'The relay is not connected.');
    }
    assert.ok(sockets.slice(1).every((s) => s.readyState === 3));
    assert.equal(sockets.length, 1 + 3, 'the queued request was never given a socket');
    await assert.rejects(relay.clip(5), { message: 'The relay is not connected.' }); // and nothing is asked after
    assert.equal(sockets.length, 1 + 3);
  });

  it('rejects at once, opening no socket, when nobody wants the relay: it was not asked, so it did not say there is no file', async () => {
    const { relay, sockets } = rig();
    await assert.rejects(relay.clip(1), { message: 'The relay is not connected.' });
    await assert.rejects(relay.image(1), { message: 'The relay is not connected.' });
    assert.equal(sockets.length, 0);
  });

  it('still asks while the data socket is between a drop and its redial: the relay may be back already', async () => {
    const { relay, sockets, up } = rig();
    up().drop();
    const image = relay.image(1);
    assert.equal(sockets.length, 2);
    sockets[1]!.open();
    sockets[1]!.receiveBinary([7]);
    assert.deepEqual(await bytes((await image)!), [7]);
  });

  it('ignores a binary frame on the data socket that nobody asked for', () => {
    const { state, up } = rig();
    const s = up();
    s.receiveBinary([1, 2, 3]);
    assert.equal(state()['connected'], true);
  });
});

// The store tells its subscribers synchronously, inside the write that a frame causes, and a
// subscriber that opens a chat's pictures asks for them right there.
describe('RelayStore: media asked for from a store subscriber', () => {
  it('pictures asked for as the chat frame lands each get their own answer, on their own socket', async () => {
    const { relay, store, sockets, up } = rig();
    const s = up();
    const pictures: Promise<Blob | null>[] = [];
    let seen: unknown;
    store.subscribe((state) => {
      if (state['loaded'] && state['loaded'] !== seen) {
        seen = state['loaded'];
        pictures.push(relay.image(5), relay.image(6));
      }
    });
    relay.openChat('c1');
    s.burst(); // the relay's answer to chat_open: the state frames, the chat list last...
    s.receive({ type: 'chat', id: 'c1', messages: [], forked: false }); // ...then the chat
    assert.equal(pictures.length, 2);
    assert.equal(sockets.length, 3);
    sockets[1]!.open();
    sockets[2]!.open();
    assert.deepEqual(sockets[1]!.frames, [{ type: 'image_get', id: 5 }]);
    assert.deepEqual(sockets[2]!.frames, [{ type: 'image_get', id: 6 }]);
    sockets[2]!.receiveBinary([6]);
    sockets[1]!.receiveBinary([5]);
    assert.deepEqual(await bytes((await pictures[0])!), [5]);
    assert.deepEqual(await bytes((await pictures[1])!), [6]);
    assert.equal(s.frames.filter((f) => f.type === 'image_get').length, 0);
  });
});
