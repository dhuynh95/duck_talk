import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createStore } from '../web/store.js';
import { RelayStore } from '../web/relay.js';

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

function rig() {
  let time = 1_000_000;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const sockets: FakeSocket[] = [];
  const store = createStore<Record<string, any>>({});
  const relay = new RelayStore({
    store,
    urlFor: () => 'ws://relay/?data=1',
    makeSocket: (url: string) => {
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

describe('RelayStore: clips and images', () => {
  it('sends clip_get and resolves with the next binary frame, as audio/wav', async () => {
    const { relay, up } = rig();
    const s = up();
    const clip = relay.clip(7);
    assert.deepEqual(s.frames.at(-1), { type: 'clip_get', id: 7 });
    s.receiveBinary([82, 73, 70, 70]);
    const blob = await clip;
    assert.ok(blob);
    assert.equal(blob.type, 'audio/wav');
    assert.deepEqual(await bytes(blob), [82, 73, 70, 70]);
  });

  it('sends image_get and resolves with a JPEG', async () => {
    const { relay, up } = rig();
    const s = up();
    const image = relay.image(3);
    assert.deepEqual(s.frames.at(-1), { type: 'image_get', id: 3 });
    s.receiveBinary([255, 216, 255]);
    const blob = await image;
    assert.equal(blob?.type, 'image/jpeg');
    assert.deepEqual(await bytes(blob!), [255, 216, 255]);
  });

  it('resolves null for a clip that is gone: the answer is text, with no audio before it', async () => {
    const { relay, up } = rig();
    const s = up();
    const clip = relay.clip(7);
    s.receive({ type: 'corrections', items: [] });
    assert.equal(await clip, null);
  });

  it('answers overlapping requests in order, sending the second only when the first is answered in full', async () => {
    const { relay, up } = rig();
    const s = up();
    const first = relay.clip(1);
    const second = relay.image(2);
    const asked = () => s.frames.filter((f) => f.type === 'clip_get' || f.type === 'image_get');
    assert.deepEqual(asked(), [{ type: 'clip_get', id: 1 }], 'one outstanding at a time');

    s.receiveBinary([1, 1]);
    assert.deepEqual(await bytes((await first)!), [1, 1]);
    assert.equal(asked().length, 1, 'the rest of the first answer is still on its way');
    s.receive({ type: 'corrections', items: [] });
    s.receive({ type: 'prompts', prompts: [] });
    assert.equal(asked().length, 1, 'text that belongs to the first answer is not the second one');

    s.receive({ type: 'chats', chats: [] }); // the end of the first answer
    assert.deepEqual(asked(), [{ type: 'clip_get', id: 1 }, { type: 'image_get', id: 2 }]);
    s.receiveBinary([2, 2]);
    assert.deepEqual(await bytes((await second)!), [2, 2]);
  });

  it('does not take the tail of a missing clip answer for the answer to the next request', async () => {
    const { relay, up } = rig();
    const s = up();
    const gone = relay.clip(1);
    const there = relay.clip(2);
    s.receive({ type: 'corrections', items: [] });
    assert.equal(await gone, null);
    s.receive({ type: 'prompts', prompts: [] });
    s.receive({ type: 'models', models: [] });
    s.receive({ type: 'skills', skills: [] });
    s.receive({ type: 'chats', chats: [] });
    assert.deepEqual(s.frames.filter((f) => f.type === 'clip_get'), [{ type: 'clip_get', id: 1 }, { type: 'clip_get', id: 2 }]);
    s.receiveBinary([9]);
    assert.deepEqual(await bytes((await there)!), [9]);
  });

  it('holds a request made before the first answer to `read` until that answer is whole', async () => {
    const { relay, last } = rig();
    relay.connect();
    last().open();
    const clip = relay.clip(4);
    assert.deepEqual(last().frames, [{ type: 'read' }]);
    last().receive({ type: 'relay', version: '1' });
    last().receive({ type: 'corrections', items: [] });
    assert.deepEqual(last().frames, [{ type: 'read' }], 'the greeting and the state are not an answer about a clip');
    last().receive({ type: 'chats', chats: [] });
    assert.deepEqual(last().frames.at(-1), { type: 'clip_get', id: 4 });
    last().receiveBinary([5]);
    assert.deepEqual(await bytes((await clip)!), [5]);
  });

  it('holds a request made while the socket is still opening, and sends it once the relay has answered', async () => {
    const { relay, last } = rig();
    relay.connect();
    const clip = relay.clip(4);
    last().open();
    last().burst();
    assert.deepEqual(last().frames.at(-1), { type: 'clip_get', id: 4 });
    last().receiveBinary([6]);
    assert.deepEqual(await bytes((await clip)!), [6]);
  });

  it('resolves null at once when there is no socket', async () => {
    const never = rig();
    assert.equal(await never.relay.clip(1), null, 'never connected');
    const dropped = rig();
    dropped.up().drop();
    assert.equal(await dropped.relay.image(1), null, 'dropped, and waiting to redial');
  });

  it('resolves a pending request null when the socket drops, and every request queued behind it, and says not connected', async () => {
    const { relay, state, up } = rig();
    const s = up();
    const first = relay.clip(1);
    const second = relay.clip(2);
    s.drop();
    assert.equal(await first, null);
    assert.equal(await second, null);
    assert.equal(state()['connected'], false);
  });

  it('resolves pending requests null on disconnect', async () => {
    const { relay, up } = rig();
    up();
    const clip = relay.clip(1);
    relay.disconnect();
    assert.equal(await clip, null);
  });

  it('times a request out after 10 s with null, as it does everything queued behind it, and redials clean', async () => {
    const { relay, sockets, last, advance, up } = rig();
    const old = up();
    const stuck = relay.clip(1);
    const behind = relay.clip(2);
    advance(9_999);
    let settled = false;
    void stuck.then(() => (settled = true));
    await tick();
    assert.equal(settled, false);
    advance(1);
    assert.equal(await stuck, null);
    assert.equal(await behind, null, 'a relay that is not answering is not asked again at once');
    assert.equal(sockets.length, 1, 'redialled after the backoff, not at once');
    advance(250);
    assert.equal(sockets.length, 2, 'a late reply on the old socket can never be taken for the next one');
    last().open();
    last().burst();
    const next = relay.clip(3);
    old.receiveBinary([0]); // the old socket's late audio
    last().receiveBinary([7]);
    assert.deepEqual(await bytes((await next)!), [7]);
  });

  it('does not time out a request that was answered', async () => {
    const { relay, sockets, advance, up } = rig();
    const s = up();
    const clip = relay.clip(1);
    s.receiveBinary([1]);
    s.burst();
    assert.ok(await clip);
    advance(60_000);
    assert.equal(sockets.length, 1);
  });

  it('ignores a binary frame nobody asked for', () => {
    const { state, up } = rig();
    const s = up();
    s.receiveBinary([1, 2, 3]);
    assert.equal(state()['connected'], true);
  });
});
