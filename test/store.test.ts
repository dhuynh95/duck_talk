import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { createStore } from '../web/store.js';

describe('createStore', () => {
  /** console.error is where a throwing subscriber is reported; a test keeps its output pristine and checks what was said. */
  const quiet = () => mock.method(console, 'error', () => {});

  it('starts with the initial state and merges each patch into it', () => {
    const store = createStore({ a: 1, b: 'x' });
    assert.deepEqual(store.get(), { a: 1, b: 'x' });
    store.set({ a: 2 });
    assert.deepEqual(store.get(), { a: 2, b: 'x' });
  });

  it('notifies subscribers once per set, with the new state', () => {
    const store = createStore({ n: 0 });
    const seen: number[] = [];
    store.subscribe((state) => seen.push(state.n));
    store.set({ n: 1 });
    store.set({ n: 2 });
    assert.deepEqual(seen, [1, 2]);
  });

  it('stops notifying a subscriber that unsubscribed, and only that one', () => {
    const store = createStore({ n: 0 });
    const first: number[] = [];
    const second: number[] = [];
    const stop = store.subscribe((state) => first.push(state.n));
    store.subscribe((state) => second.push(state.n));
    store.set({ n: 1 });
    stop();
    store.set({ n: 2 });
    assert.deepEqual(first, [1]);
    assert.deepEqual(second, [1, 2]);
  });

  it('does not mutate the state it handed out earlier', () => {
    const store = createStore({ n: 0 });
    const before = store.get();
    store.set({ n: 1 });
    assert.equal(before.n, 0);
  });

  it('lets a subscriber unsubscribe itself while being notified', () => {
    const store = createStore({ n: 0 });
    const seen: number[] = [];
    const stop = store.subscribe((state) => {
      seen.push(state.n);
      stop();
    });
    store.subscribe((state) => seen.push(state.n * 10));
    store.set({ n: 1 });
    store.set({ n: 2 });
    assert.deepEqual(seen, [1, 10, 20]);
  });

  describe('one subscriber failing', () => {
    it('does not stop the next subscriber from being told about the same write', () => {
      const errors = quiet();
      const store = createStore({ n: 0 });
      const seen: string[] = [];
      store.subscribe(() => seen.push('a'));
      store.subscribe(() => {
        throw new Error('this one is broken');
      });
      store.subscribe((state) => seen.push(`c${state.n}`));
      store.set({ n: 1 });
      assert.deepEqual(seen, ['a', 'c1']);
      assert.equal(store.get().n, 1, 'the write itself landed');
      assert.equal(errors.mock.callCount(), 1, 'and the failure was reported rather than swallowed');
      assert.match(String(errors.mock.calls[0]!.arguments.at(-1)), /this one is broken/);
      errors.mock.restore();
    });

    it('is told about the next write as well: a subscriber that threw is not dropped', () => {
      const errors = quiet();
      const store = createStore({ n: 0 });
      let calls = 0;
      store.subscribe(() => {
        calls++;
        throw new Error('still broken');
      });
      store.set({ n: 1 });
      store.set({ n: 2 });
      assert.equal(calls, 2);
      assert.equal(errors.mock.callCount(), 2);
      errors.mock.restore();
    });

    it('does not let set() throw at its caller', () => {
      const errors = quiet();
      const store = createStore({ n: 0 });
      store.subscribe(() => {
        throw new Error('nobody who writes to the store should have to catch this');
      });
      assert.doesNotThrow(() => store.set({ n: 1 }));
      errors.mock.restore();
    });
  });

  describe('unsubscribing while being notified', () => {
    it('skips a subscriber that an earlier one unsubscribed during the same write', () => {
      const store = createStore({ n: 0 });
      const seen: string[] = [];
      let stopSecond = () => {};
      store.subscribe(() => {
        seen.push('first');
        stopSecond();
      });
      stopSecond = store.subscribe(() => seen.push('second'));
      store.subscribe(() => seen.push('third'));
      store.set({ n: 1 });
      assert.deepEqual(seen, ['first', 'third']);
      store.set({ n: 2 });
      assert.deepEqual(seen, ['first', 'third', 'first', 'third'], 'and stays gone');
    });

    it('does not tell a subscriber added during a write about that write, only the next', () => {
      const store = createStore({ n: 0 });
      const late: number[] = [];
      let added = false;
      store.subscribe(() => {
        if (added) return;
        added = true;
        store.subscribe((state) => late.push(state.n));
      });
      store.set({ n: 1 });
      assert.deepEqual(late, []);
      store.set({ n: 2 });
      assert.deepEqual(late, [2]);
    });

    it('keeps the order subscribers were added in, failures included', () => {
      const errors = quiet();
      const store = createStore({ n: 0 });
      const seen: string[] = [];
      store.subscribe(() => seen.push('1'));
      store.subscribe(() => {
        seen.push('2');
        throw new Error('2 fails');
      });
      store.subscribe(() => seen.push('3'));
      store.set({ n: 1 });
      assert.deepEqual(seen, ['1', '2', '3']);
      errors.mock.restore();
    });
  });
});
