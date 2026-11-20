// @ts-check
// The chats: every conversation Claude Code has in this project, including the ones started in a
// terminal, since it is the same store either way. `ChatsDrawer` in Chats.swift, ported.
//
// On a phone it slides in from the left over a dimmed page and is modal in every way a keyboard
// can tell: focus goes in, Tab stays in, Esc and a tap outside put it away, and focus goes back to
// the button that opened it. From 900 px wide it is a permanent sidebar and none of that applies.
// Tapping a row does not start anything: it loads the conversation onto the screen, and what you
// do next — talk or type — carries it on.
//
// The list is the relay's, in the relay's order (starred first, then most recent), and it is kept,
// not redrawn: one row per chat, found by its id, changed in place. The store is written 25 times
// a second while the microphone is open, so a write that touches none of the chats is a few
// comparisons. A title is somebody else's text — a chat started in a terminal is named from what
// was said in it — and only ever reaches the page as text.
//
// What can be done to a chat is behind its ⋯: star it, rename it, delete it. The last two ask in
// the page (a sheet), never with the browser's own dialogs, and deleting asks twice because the
// transcript goes with it.

import { h } from '../dom.js';
import { icon } from './icons.js';
import { openSheet } from './sheet.js';

/** @typedef {import('../relay.js').Chat} Chat */
/** @typedef {{ get: () => Record<string, any>, subscribe: (fn: (state: Record<string, any>) => void) => () => void }} Store */
/**
 * What choosing something in the drawer does, which is the page's to say.
 * @typedef {{
 *   open: (id: string) => void,
 *   newChat: () => void,
 *   star: (id: string, on: boolean) => void,
 *   rename: (id: string, title: string) => void,
 *   remove: (id: string) => void,
 * }} DrawerActions
 */
/** @typedef {{ el: HTMLElement, open: (opener?: HTMLElement | null) => void, close: () => void, isOpen: () => boolean }} Drawer */

/** From this wide the drawer is a sidebar. The stylesheet says the same number. */
const WIDE = '(min-width: 900px)';
/** The longest title a rename may give. */
const MAX_TITLE = 200;
/** How often "2 h ago" is recounted while nothing else has changed, in ms. */
const REFRESH = 60_000;

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// MARK: the rules

/**
 * How long ago a chat was last written to, for its row: "now", "5 min ago", "2 h ago", "3 d ago".
 * A time in the future (a clock that disagrees with the relay's) is "now", and a time that is not
 * one says nothing.
 * @param {number} at when, in milliseconds
 * @param {number} now
 */
export function relativeTime(at, now) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return '';
  const seconds = (now - at) / 1000;
  if (seconds < MINUTE) return 'now';
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)} min ago`;
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)} h ago`;
  const days = Math.floor(seconds / DAY);
  return days < 365 ? `${days} d ago` : `${Math.floor(days / 365)} y ago`;
}

/** What a row calls a chat: its title, or "Untitled" for one with no words in it. @param {{ title?: unknown }} chat */
export function chatTitle(chat) {
  const title = typeof chat.title === 'string' ? chat.title.trim() : '';
  return title || 'Untitled';
}

/**
 * The same list with fewer rows in it: the chats whose title holds what was typed, without regard
 * to case, in the order they came in. An empty query keeps them all. The query is text to find,
 * not a pattern.
 * @template {{ title?: unknown }} T
 * @param {T[]} chats
 * @param {string} query
 * @returns {T[]}
 */
export function filterChats(chats, query) {
  const asked = query.trim().toLowerCase();
  if (!asked) return chats;
  return chats.filter((chat) => chatTitle(chat).toLowerCase().includes(asked));
}

// MARK: the drawer

/**
 * One chat's row. `chat` is the relay's latest word on it, read when a press arrives; `drawn` is
 * what the row last looked like, so a row that has not changed is not touched.
 * @typedef {{
 *   el: HTMLElement,
 *   open: HTMLButtonElement,
 *   menu: HTMLButtonElement,
 *   title: HTMLElement,
 *   star: HTMLElement,
 *   time: HTMLElement,
 *   pill: HTMLElement,
 *   chat: Chat,
 *   drawn: string,
 * }} Row
 */

/** What Tab can reach inside `root`, in order. @param {HTMLElement} root @returns {HTMLElement[]} */
function tabbable(root) {
  return [...root.querySelectorAll('button, input')]
    .filter((el) => el instanceof HTMLElement && !(/** @type {HTMLButtonElement} */ (el).disabled) && !el.closest('[hidden]'))
    .map((el) => /** @type {HTMLElement} */ (el));
}

/**
 * @param {Store} store
 * @param {DrawerActions} actions
 * @returns {Drawer}
 */
export function chatsDrawer(store, actions) {
  const wide = typeof matchMedia === 'function' ? matchMedia(WIDE) : null;

  const closeButton = h('button', { class: 'round plain drawer-close', type: 'button', 'aria-label': 'Close chats' }, icon('close'));
  const search = h('input', {
    class: 'drawer-search-input',
    type: 'search',
    placeholder: 'Search',
    'aria-label': 'Search chats',
    autocomplete: 'off',
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
  });
  const clear = h('button', { class: 'drawer-search-clear', type: 'button', 'aria-label': 'Clear search', hidden: true }, icon('close'));
  const searchBox = h('div', { class: 'drawer-search', hidden: true }, icon('search'), search, clear);
  const note = h('p', { class: 'drawer-note', role: 'status', hidden: true });
  const list = h('ul', { class: 'chat-list' });
  const emptyTitle = h('p', { class: 'empty-title' });
  const emptyDetail = h('p', { class: 'empty-detail' });
  const empty = h('div', { class: 'drawer-empty', hidden: true }, emptyTitle, emptyDetail);
  const newChat = h('button', { class: 'new-chat floating', type: 'button' }, icon('plus'), h('span', null, 'New chat'));

  const panel = h(
    'aside',
    { class: 'drawer-panel', 'aria-label': 'Chats', tabindex: '-1' },
    h('div', { class: 'drawer-head' }, h('h2', { class: 'drawer-title' }, 'Chats'), closeButton),
    searchBox,
    note,
    h('div', { class: 'chat-scroll' }, list, empty),
    h('div', { class: 'drawer-foot' }, newChat),
  );
  const backdrop = h('div', { class: 'drawer-backdrop', onclick: () => close() });
  const el = h('div', { class: 'drawer' }, backdrop, panel);

  // MARK: opening and closing

  let opened = false;
  /** @type {HTMLElement | null} */
  let opener = null;

  /** The panel is a dialog only while it is over the page; as a sidebar it is part of it. */
  const sync = () => {
    const dialog = opened && !wide?.matches;
    if (dialog) {
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
    } else {
      panel.removeAttribute('role');
      panel.removeAttribute('aria-modal');
    }
  };

  /** @param {KeyboardEvent} event */
  const onKey = (event) => {
    // A dialog over the drawer (rename, delete) has the keyboard, and its own Esc and Tab.
    if (document.documentElement.classList.contains('sheet-open')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = tabbable(panel);
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const at = document.activeElement;
    if (!(at instanceof Node) || !panel.contains(at)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && (at === first || at === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && at === last) {
      event.preventDefault();
      first.focus();
    }
  };

  /** @param {boolean} [restoreFocus] */
  function close(restoreFocus = true) {
    if (!opened) return;
    opened = false;
    el.classList.remove('open');
    document.removeEventListener('keydown', onKey, true);
    sync();
    if (search.value) {
      // It opens showing everything, not yesterday's search.
      search.value = '';
      clear.hidden = true;
      render(store.get());
    }
    if (restoreFocus && opener?.isConnected) opener.focus({ preventScroll: true });
    opener = null;
  }

  /** @param {HTMLElement | null} [from] the button that was pressed, which is where focus goes back to */
  function open(from) {
    if (opened || wide?.matches) return; // a sidebar is already open
    opened = true;
    const active = document.activeElement;
    opener = from ?? (active instanceof HTMLElement && active !== document.body ? active : null);
    el.classList.add('open');
    sync();
    render(store.get()); // "2 h ago" is as of now, not as of the last list
    document.addEventListener('keydown', onKey, true);
    closeButton.focus({ preventScroll: true });
  }

  // A phone turned on its side, or a window made wide, while the drawer is over the page.
  wide?.addEventListener('change', () => {
    if (wide.matches) close(false);
    sync();
  });

  closeButton.addEventListener('click', () => close());
  newChat.addEventListener('click', () => {
    if (opened) close();
    actions.newChat();
  });

  // MARK: the rows

  /** @type {Map<string, Row>} */
  const rows = new Map();

  /** @param {string} id */
  const pick = (id) => {
    if (opened) close();
    actions.open(id);
  };

  /** @param {Chat} chat @returns {Row} */
  function makeRow(chat) {
    const star = h('span', { class: 'chat-star', hidden: true }, icon('star-filled'), h('span', { class: 'sr' }, 'Starred'));
    const title = h('span', { class: 'chat-title' });
    const pill = h('span', { class: 'pill', hidden: true }, 'working');
    const time = h('span', { class: 'chat-time' });
    const open = h('button', { class: 'chat-open', type: 'button' }, star, title, h('span', { class: 'chat-meta' }, pill, time));
    const menu = h('button', { class: 'chat-menu', type: 'button', 'aria-label': 'Chat actions', 'aria-haspopup': 'dialog' }, icon('dots'));
    /** @type {Row} */
    const row = { el: h('li', { class: 'chat-row' }, open, menu), open, menu, title, star, time, pill, chat, drawn: '' };
    open.addEventListener('click', () => pick(row.chat.id));
    menu.addEventListener('click', () => chatMenu(row.chat, menu));
    return row;
  }

  /** @param {Row} row @param {Chat} chat @param {boolean} active @param {boolean} offline @param {number} now */
  function updateRow(row, chat, active, offline, now) {
    row.chat = chat;
    const name = chatTitle(chat);
    const ago = relativeTime(chat.at, now);
    const starred = chat.starred === true;
    const working = chat.working === true;
    const key = `${name}|${ago}|${starred}|${working}|${active}|${offline}`;
    if (key === row.drawn) return;
    row.drawn = key;
    if (row.title.textContent !== name) row.title.textContent = name;
    row.open.title = name; // the whole of a title the row has cut short
    row.star.hidden = !starred;
    row.pill.hidden = !working;
    // Working replaces the age, because working is the age: it is being written to right now.
    row.time.hidden = working;
    if (row.time.textContent !== ago) row.time.textContent = ago;
    if (active) row.open.setAttribute('aria-current', 'true');
    else row.open.removeAttribute('aria-current');
    row.el.classList.toggle('active', active);
    row.open.disabled = offline;
    row.menu.disabled = offline;
  }

  /** What to say where the rows would be, and where there are none. @param {Chat[] | undefined} chats @param {Chat[]} shown @param {boolean} offline @returns {[string, string] | null} */
  function emptyWords(chats, shown, offline) {
    if (!chats) return offline ? ["Can't reach the relay.", 'Chats will appear here when it answers.'] : ['Loading chats…', ''];
    if (chats.length === 0) return ['No chats yet.', 'Every conversation with Claude Code in this project shows up here — including the ones you start in a terminal.'];
    return shown.length === 0 ? ['Nothing matches.', ''] : null;
  }

  /** @param {Record<string, any>} state */
  function render(state) {
    /** @type {Chat[] | undefined} */
    const chats = Array.isArray(state['chats']) ? state['chats'].filter((c) => typeof c?.id === 'string') : undefined;
    const shown = chats ? filterChats(chats, search.value) : [];
    const active = typeof state['chatId'] === 'string' ? state['chatId'] : null;
    // The page opens with `connected` false for as long as it takes the relay to answer, so a drop is
    // only said once there is something to say it about: a list that was, or an error.
    const offline = state['connected'] === false && (chats !== undefined || !!state['relayError']);
    const now = Date.now();

    searchBox.hidden = !chats?.length;
    note.hidden = !(offline && chats !== undefined);
    if (!note.hidden && !note.textContent) note.textContent = 'Offline. Chats are as they were when the relay last answered, and cannot be opened or changed until it does.';

    const words = emptyWords(chats, shown, offline);
    empty.hidden = words === null;
    if (words) {
      if (emptyTitle.textContent !== words[0]) emptyTitle.textContent = words[0];
      if (emptyDetail.textContent !== words[1]) emptyDetail.textContent = words[1];
      emptyDetail.hidden = !words[1];
    }

    const hadFocus = list.contains(document.activeElement);
    /** @type {Set<string>} */
    const seen = new Set();
    for (const chat of shown) {
      if (seen.has(chat.id)) continue; // one row per id, whatever the relay said
      let row = rows.get(chat.id);
      if (!row) {
        row = makeRow(chat);
        rows.set(chat.id, row);
      }
      updateRow(row, chat, chat.id === active, offline, now);
      const here = list.children[seen.size];
      if (here !== row.el) list.insertBefore(row.el, here ?? null);
      seen.add(chat.id);
    }
    for (const [id, row] of rows) {
      if (!seen.has(id)) {
        row.el.remove();
        rows.delete(id);
      }
    }
    // The row that had the keyboard is gone (deleted, or filtered out): it goes somewhere that is.
    if (hadFocus && !list.contains(document.activeElement)) (searchBox.hidden ? newChat : search).focus({ preventScroll: true });
  }

  search.addEventListener('input', () => {
    clear.hidden = !search.value;
    render(store.get());
  });
  clear.addEventListener('click', () => {
    search.value = '';
    clear.hidden = true;
    render(store.get());
    search.focus({ preventScroll: true });
  });

  // The store is written 25 times a second while the microphone is open: only these matter here.
  /** @type {Record<string, unknown>} */
  let drawn = {};
  /** @param {Record<string, any>} state */
  const onState = (state) => {
    if (state['chats'] === drawn['chats'] && state['chatId'] === drawn['chatId'] && state['connected'] === drawn['connected'] && state['relayError'] === drawn['relayError']) return;
    drawn = { chats: state['chats'], chatId: state['chatId'], connected: state['connected'], relayError: state['relayError'] };
    render(state);
  };
  render(store.get());
  drawn = { chats: store.get()['chats'], chatId: store.get()['chatId'], connected: store.get()['connected'], relayError: store.get()['relayError'] };
  store.subscribe(onState);
  setInterval(() => render(store.get()), REFRESH);

  // MARK: what can be done to a chat

  /** @param {Chat} chat @param {HTMLElement} from the ⋯ that was pressed */
  function chatMenu(chat, from) {
    const starred = chat.starred === true;
    /** @type {[string, string, import('./icons.js').IconName, boolean][]} */
    const choices = [
      [starred ? 'Unstar' : 'Star', 'star', starred ? 'star-filled' : 'star', false],
      ['Rename', 'rename', 'pencil', false],
      ['Delete', 'delete', 'trash', true],
    ];
    const items = choices.map(([text, id, name, danger], index) =>
      h(
        'button',
        {
          class: danger ? 'choice has-icon danger' : 'choice has-icon',
          type: 'button',
          role: 'menuitem',
          tabindex: index === 0 ? '0' : '-1',
          dataset: { action: id },
          onclick: () => {
            sheet.close();
            if (id === 'star') actions.star(chat.id, !starred);
            else if (id === 'rename') renameDialog(chat, from);
            else confirmDelete(chat, from);
          },
        },
        h('span', { class: 'choice-icon' }, icon(name)),
        h('span', { class: 'choice-text' }, h('span', { class: 'choice-title' }, text)),
      ),
    );
    const menu = h('div', { class: 'choice-list', role: 'menu', 'aria-label': 'Chat actions' }, items);
    menu.addEventListener('keydown', (event) => {
      const at = items.findIndex((item) => item === document.activeElement);
      const last = items.length - 1;
      const to = event.key === 'ArrowDown' ? (at >= last ? 0 : at + 1) : event.key === 'ArrowUp' ? (at <= 0 ? last : at - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? last : -1;
      if (to < 0) return;
      event.preventDefault();
      items.forEach((item, i) => (item.tabIndex = i === to ? 0 : -1));
      items[to]?.focus();
    });
    const sheet = openSheet({ title: 'Chat actions', content: h('div', { class: 'dialog' }, h('p', { class: 'dialog-subject' }, chatTitle(chat)), menu), opener: from });
  }

  /** @param {Chat} chat @param {HTMLElement} from */
  function renameDialog(chat, from) {
    const input = h('input', {
      id: 'rename-title',
      class: 'field',
      type: 'text',
      maxlength: String(MAX_TITLE),
      autocomplete: 'off',
      spellcheck: 'false',
      dataset: { autofocus: '' },
    });
    input.value = chat.title ?? '';
    const save = h('button', { class: 'button primary', type: 'submit' }, 'Save');
    const ready = () => {
      save.disabled = !input.value.trim();
    };
    input.addEventListener('input', ready);
    const form = h(
      'form',
      { class: 'dialog' },
      h('label', { for: 'rename-title', class: 'dialog-label' }, 'Title'),
      input,
      h('div', { class: 'dialog-actions' }, h('button', { class: 'button', type: 'button', onclick: () => sheet.close() }, 'Cancel'), save),
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      sheet.close();
      if (title !== chat.title) actions.rename(chat.id, title);
    });
    const sheet = openSheet({ title: 'Rename chat', content: form, opener: from });
    input.select();
    ready();
  }

  /** Irreversible, and the transcript goes with it: the one thing here that asks twice. @param {Chat} chat @param {HTMLElement} from */
  function confirmDelete(chat, from) {
    const content = h(
      'div',
      { class: 'dialog' },
      h('p', { class: 'dialog-subject' }, chatTitle(chat)),
      h('p', { class: 'dialog-text' }, 'The conversation and everything in it go for good.'),
      h(
        'div',
        { class: 'dialog-actions' },
        h('button', { class: 'button', type: 'button', dataset: { autofocus: '' }, onclick: () => sheet.close() }, 'Cancel'),
        h(
          'button',
          {
            class: 'button danger',
            type: 'button',
            onclick: () => {
              sheet.close();
              actions.remove(chat.id);
            },
          },
          'Delete',
        ),
      ),
    );
    const sheet = openSheet({ title: 'Delete this chat?', content, opener: from });
  }

  sync();
  return { el, open, close: () => close(), isOpen: () => opened };
}
