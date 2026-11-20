// @ts-check
// What this browser remembers about how Duck Talk should behave: the choices the pickers make,
// kept as one JSON object in localStorage, as the iPhone app keeps them in UserDefaults.
//
// Anything can be in storage by the time it is read — a hand-edited value, an older version's
// shape, nothing at all, or no storage (blocked site data throws on the property itself) — so
// each field is checked on its own, and one that fails costs that field and no other. The same
// check runs on the way out, so what is written is always something this reads back.

const STORAGE_NAME = 'duck-talk-settings';

/** What happens to what you say; bound when a chat's socket opens, so changing it reconnects. */
export const MODE_IDS = /** @type {const} */ (['direct', 'review']);
/** What Claude may do: the SDK's own names, so nothing between the picker and the relay translates. */
export const PERMISSION_IDS = /** @type {const} */ (['plan', 'acceptEdits', 'bypassPermissions']);

/**
 * `model` and `effort` are whatever the relay's list offers (`default` means the CLI's own choice);
 * `output` is the speaker; `gate` keeps the microphone quiet while the reply is in the room.
 * @typedef {{
 *   mode: typeof MODE_IDS[number],
 *   model: string,
 *   effort: string,
 *   permission: typeof PERMISSION_IDS[number],
 *   autocorrect: boolean,
 *   output: boolean,
 *   gate: boolean,
 * }} Settings
 */

/** @typedef {Pick<Storage, 'getItem' | 'setItem'>} SettingsStorage */

/** @returns {Settings} */
function defaults() {
  return { mode: 'direct', model: 'default', effort: 'default', permission: 'plan', autocorrect: false, output: true, gate: true };
}

/**
 * The settings in `raw`, field by field, with the default for each that is missing or not one
 * of the values it may be. Keys it does not know are not carried over.
 * @param {unknown} raw
 * @returns {Settings}
 */
export function normalizeSettings(raw) {
  const out = defaults();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  const get = (/** @type {string} */ key) => (Object.hasOwn(raw, key) ? /** @type {Record<string, unknown>} */ (raw)[key] : undefined);

  const mode = get('mode');
  if (MODE_IDS.some((id) => id === mode)) out.mode = /** @type {Settings['mode']} */ (mode);
  const permission = get('permission');
  if (PERMISSION_IDS.some((id) => id === permission)) out.permission = /** @type {Settings['permission']} */ (permission);
  const model = get('model');
  if (typeof model === 'string' && model) out.model = model;
  const effort = get('effort');
  if (typeof effort === 'string' && effort) out.effort = effort;
  for (const key of /** @type {const} */ (['autocorrect', 'output', 'gate'])) {
    const value = get(key);
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

/**
 * What was kept, or the defaults.
 * @param {SettingsStorage | null} storage
 * @returns {Settings}
 */
export function loadSettings(storage) {
  try {
    const text = storage?.getItem(STORAGE_NAME);
    return normalizeSettings(text ? JSON.parse(text) : undefined);
  } catch {
    return defaults();
  }
}

/**
 * Keeps `settings`; false if the browser would not.
 * @param {SettingsStorage | null} storage
 * @param {Settings} settings
 */
export function saveSettings(storage, settings) {
  try {
    if (!storage) return false;
    storage.setItem(STORAGE_NAME, JSON.stringify(normalizeSettings(settings)));
    return true;
  } catch {
    return false;
  }
}
