// @ts-check
// The `/` list: which of the project's skills match what has been typed after the slash. The
// list itself is the relay's (the `skills` frame, kept in the store); this is only the filter over
// it, run on every keystroke, so nothing is asked of the relay as you type.

/** One skill the project offers: its name, what it does, and what it takes after its name (empty for nothing). @typedef {{ name: string, description: string, argumentHint: string }} Skill */

/**
 * The skills that match `query` (what is typed after the slash, without it): names that start
 * with it first, then names that merely contain it, each group in the order the relay listed
 * them, case ignored. An empty query is every skill. A row with no name is left out — there is
 * nothing to insert — and every other field is allowed to be missing.
 * @template {{ name: string }} T
 * @param {T[] | null | undefined} skills
 * @param {string} query
 * @returns {T[]}
 */
export function filterSkills(skills, query) {
  if (!Array.isArray(skills)) return [];
  const named = skills.filter((s) => typeof s?.name === 'string' && s.name !== '');
  const wanted = query.toLowerCase();
  if (!wanted) return named;
  /** @type {T[]} */
  const starting = [];
  /** @type {T[]} */
  const containing = [];
  for (const skill of named) {
    const name = skill.name.toLowerCase();
    if (name.startsWith(wanted)) starting.push(skill);
    else if (name.includes(wanted)) containing.push(skill);
  }
  return [...starting, ...containing];
}

/**
 * What the list should filter by for the text in the field, or null when it should not be open:
 * the text is exactly a slash and then characters that are not space. Typing a space ends it —
 * the name is chosen and what follows is its argument — and so does any text that does not begin
 * with a slash.
 * @param {string} text
 * @returns {string | null}
 */
export function skillQuery(text) {
  return /^\/(\S*)$/.exec(text)?.[1] ?? null;
}
