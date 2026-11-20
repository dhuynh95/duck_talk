// @ts-check
// "/" reaches for a skill: type a slash in the field and a list rises over the composer with the
// project's skills that match so far. It is the field's combobox — focus never leaves the
// textarea, which names the highlighted option with aria-activedescendant — filtered on every
// keystroke from the list the data socket already delivered; nothing is asked of the relay.
//
// Picking puts `/name ` in the field rather than sending, because a skill can take arguments:
// the arrow sends it, and Claude runs it the way it runs anything typed. Esc closes the list and
// nothing else — whoever handles Esc for the page must hear that the list took it (it is
// prevented, and stopped) — and typing again opens it again.
//
// A skill's name, description and hint are the project's text, never markup.

import { h } from '../dom.js';
import { filterSkills, skillQuery } from '../skills.js';

/** @typedef {import('../skills.js').Skill} Skill */
/** @typedef {{ get: () => Record<string, any>, subscribe: (fn: (state: Record<string, any>) => void) => () => void }} Store */

const LIST_ID = 'skill-list';

/**
 * @param {HTMLTextAreaElement} input the field the list belongs to; it becomes its combobox
 * @param {Store} store where the relay's `skills` are
 * @param {(skill: Skill) => void} pick what choosing one does; the list is closed first
 * @returns {{ el: HTMLElement, update: () => void, close: () => void, isOpen: () => boolean, keydown: (event: KeyboardEvent) => boolean }}
 *   `update` re-reads the field (call it when the text changes); `keydown` says whether it used the key
 */
export function skillList(input, store, pick) {
  const el = h('div', { class: 'skill-list', id: LIST_ID, role: 'listbox', 'aria-label': 'Skills', hidden: true });
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', LIST_ID);
  input.setAttribute('aria-expanded', 'false');

  /** @type {Skill[]} */
  let shown = [];
  /** @type {HTMLElement[]} */
  let options = [];
  /** @type {string} what the options were built from */
  let built = '';
  let active = 0;
  let focused = false;
  /** Closed by Esc: stays closed until the text changes. */
  let dismissed = false;
  /** @type {unknown} */
  let seenSkills = store.get()['skills'];

  /** @param {Skill} skill @param {number} i */
  function option(skill, i) {
    const row = h(
      'div',
      { class: 'skill-option', id: `skill-option-${i}`, role: 'option', 'aria-selected': 'false' },
      h('span', { class: 'skill-name' }, `/${skill.name}`),
      skill.argumentHint ? h('span', { class: 'skill-hint' }, skill.argumentHint) : null,
      skill.description ? h('span', { class: 'skill-desc' }, skill.description) : null,
    );
    row.addEventListener('click', () => choose(skill));
    // Pointing at a row makes it the one Enter would take, so the highlight never says two things.
    row.addEventListener('pointermove', () => {
      if (active !== i) mark(i);
    });
    return row;
  }

  /** @param {number} next */
  function mark(next) {
    active = next;
    options.forEach((row, i) => row.setAttribute('aria-selected', String(i === active)));
    const row = options[active];
    if (row) {
      input.setAttribute('aria-activedescendant', row.id);
      row.scrollIntoView({ block: 'nearest' });
    }
  }

  /** @param {Skill} skill */
  function choose(skill) {
    close();
    pick(skill);
    input.focus({ preventScroll: true });
  }

  function close() {
    el.hidden = true;
    shown = [];
    built = '';
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function update() {
    const query = focused && !dismissed ? skillQuery(input.value) : null;
    const matches = query === null ? [] : filterSkills(/** @type {Skill[]} */ (store.get()['skills']), query);
    if (matches.length === 0) {
      if (!el.hidden) close();
      return;
    }
    const key = matches.map((s) => s.name).join('\n');
    shown = matches;
    if (key !== built) {
      built = key;
      options = matches.map(option);
      el.replaceChildren(...options);
      active = 0;
    }
    el.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    mark(Math.min(active, options.length - 1));
  }

  /** @param {KeyboardEvent} event */
  function keydown(event) {
    if (el.hidden || shown.length === 0) return false;
    if (event.isComposing || event.keyCode === 229) return false; // choosing a character, not a skill
    const n = shown.length;
    switch (event.key) {
      case 'ArrowDown':
        mark((active + 1) % n);
        break;
      case 'ArrowUp':
        mark((active - 1 + n) % n);
        break;
      case 'Enter':
      case 'Tab': {
        if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
        const skill = shown[active];
        if (skill) choose(skill);
        break;
      }
      case 'Escape':
        dismissed = true;
        close();
        event.stopPropagation(); // the page's Esc stops Claude; this one only puts the list away
        break;
      default:
        return false;
    }
    event.preventDefault();
    return true;
  }

  // A press on the list must not take the keyboard from the field: the field losing focus is what
  // closes it, and the tap that picks would otherwise close it first.
  el.addEventListener('mousedown', (event) => event.preventDefault());
  input.addEventListener('input', () => {
    dismissed = false;
    update();
  });
  input.addEventListener('focus', () => {
    focused = true;
    update();
  });
  input.addEventListener('blur', () => {
    focused = false;
    update();
  });
  store.subscribe((state) => {
    if (state['skills'] === seenSkills) return;
    seenSkills = state['skills'];
    update();
  });

  return { el, update, close, isOpen: () => !el.hidden, keydown };
}
