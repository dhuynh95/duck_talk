import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createStore } from '../web/store.js';

describe('createStore', () => {
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
});
