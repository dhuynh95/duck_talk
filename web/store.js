// @ts-check
// A tiny observable: one object of state, replaced on every `set`, and a call to each
// subscriber when it is. The screens read `get()` and redraw from `subscribe`, which is all
// the page needs of what `@Observable` does in the iPhone app.

/**
 * @template {Record<string, any>} T
 * @param {T} initial
 * @returns {{
 *   get: () => T,
 *   set: (patch: Partial<T>) => void,
 *   subscribe: (fn: (state: T) => void) => () => void,
 * }}
 */
export function createStore(initial) {
  let state = initial;
  /** @type {Set<(state: T) => void>} */
  const subscribers = new Set();

  return {
    get: () => state,

    // A new object each time, so a state handed out earlier never changes under its holder.
    set(patch) {
      state = { ...state, ...patch };
      for (const fn of [...subscribers]) fn(state); // a copy: a subscriber may unsubscribe as it is called
    },

    /** Calls `fn` with the new state after each `set` — not at once with the current one. */
    subscribe(fn) {
      subscribers.add(fn);
      return () => void subscribers.delete(fn);
    },
  };
}
