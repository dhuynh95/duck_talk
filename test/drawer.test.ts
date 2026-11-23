import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chatTitle, filterChats, relativeTime } from '../web/ui/drawer.js';

// The rules the chats drawer draws by. The drawer itself (focus, backdrop, the menus) is looked at
// in Chrome.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;

describe('relativeTime: how long ago a chat was last written to', () => {
  const ago = (ms: number) => relativeTime(NOW - ms, NOW);

  it('is "now" for the first minute', () => {
    assert.equal(ago(0), 'now');
    assert.equal(ago(59_999), 'now');
  });

  it('counts minutes up to the hour', () => {
    assert.equal(ago(MIN), '1 min ago');
    assert.equal(ago(5 * MIN + 30_000), '5 min ago');
    assert.equal(ago(HOUR - 1), '59 min ago');
  });

  it('counts whole hours up to the day, rounding down', () => {
    assert.equal(ago(HOUR), '1 h ago');
    assert.equal(ago(2 * HOUR + 59 * MIN), '2 h ago');
    assert.equal(ago(DAY - 1), '23 h ago');
  });

  it('counts days from then on, as the phone does, and years once a year has passed', () => {
    assert.equal(ago(DAY), '1 d ago');
    assert.equal(ago(6 * DAY + HOUR), '6 d ago');
    assert.equal(ago(86 * DAY), '86 d ago');
    assert.equal(ago(365 * DAY), '1 y ago');
    assert.equal(ago(800 * DAY), '2 y ago');
  });

  it('is "now" for a chat stamped in the future, which a clock that disagrees with the relay\'s will make', () => {
    assert.equal(relativeTime(NOW + 5 * HOUR, NOW), 'now');
  });

  it('says nothing for a time that is not one', () => {
    assert.equal(relativeTime(Number.NaN, NOW), '');
    assert.equal(relativeTime(undefined as unknown as number, NOW), '');
    assert.equal(relativeTime('yesterday' as unknown as number, NOW), '');
  });
});

describe('chatTitle: what a row calls a chat', () => {
  it('is the title as it is', () => {
    assert.equal(chatTitle({ title: 'Fix the login bug' }), 'Fix the login bug');
  });

  it('is "Untitled" for a chat with no words in its title', () => {
    assert.equal(chatTitle({ title: '' }), 'Untitled');
    assert.equal(chatTitle({ title: '   \n' }), 'Untitled');
    assert.equal(chatTitle({}), 'Untitled');
    assert.equal(chatTitle({ title: 7 as unknown as string }), 'Untitled');
  });
});

describe('filterChats: the same list with fewer rows in it', () => {
  const chat = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, at: 1, title, ...extra });
  const chats = [
    chat('a', 'Starred: Deploy notes', { starred: true }),
    chat('b', 'Fix the LOGIN bug'),
    chat('c', ''),
    chat('d', 'Refactor login form'),
    chat('e', 'Lunch'),
  ];
  const ids = (list: { id: string }[]) => list.map((c) => c.id);

  it('returns every chat, in the relay\'s order, for an empty or blank query', () => {
    assert.deepEqual(ids(filterChats(chats, '')), ['a', 'b', 'c', 'd', 'e']);
    assert.deepEqual(ids(filterChats(chats, '   ')), ['a', 'b', 'c', 'd', 'e']);
  });

  it('keeps the chats whose title holds the query, without regard to case, in the order it was given', () => {
    assert.deepEqual(ids(filterChats(chats, 'login')), ['b', 'd']);
    assert.deepEqual(ids(filterChats(chats, 'LOGIN')), ['b', 'd']);
    assert.deepEqual(ids(filterChats(chats, 'o')), ['a', 'b', 'd']);
  });

  it('ignores the spaces around the query, and matches in the middle of a title', () => {
    assert.deepEqual(ids(filterChats(chats, '  ogin ')), ['b', 'd']);
  });

  it('finds an untitled chat under the word it is shown with', () => {
    assert.deepEqual(ids(filterChats(chats, 'untitled')), ['c']);
  });

  it('is empty when nothing matches, and does not treat the query as a pattern', () => {
    assert.deepEqual(filterChats(chats, 'zebra'), []);
    assert.deepEqual(filterChats(chats, '.*'), []);
    assert.deepEqual(filterChats(chats, '('), []);
  });

  it('does not change the list it was given', () => {
    const before = chats.map((c) => c.id);
    filterChats(chats, 'login');
    assert.deepEqual(chats.map((c) => c.id), before);
  });
});
