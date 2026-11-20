import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { filterSkills, skillQuery } from '../web/skills.js';

const skill = (name: string, description = '', argumentHint = '') => ({ name, description, argumentHint });
const names = (rows: { name: string }[]) => rows.map((s) => s.name);

describe('filterSkills', () => {
  const skills = [skill('simplify'), skill('review'), skill('security-review'), skill('init'), skill('code-review'), skill('revert')];

  it('lists names that start with the query before names that merely contain it', () => {
    assert.deepEqual(names(filterSkills(skills, 're')), ['review', 'revert', 'security-review', 'code-review']);
  });

  it('keeps the relay\'s order inside each group', () => {
    assert.deepEqual(names(filterSkills(skills, 'i')), ['init', 'simplify', 'review', 'security-review', 'code-review']);
    assert.deepEqual(names(filterSkills([skill('b-x'), skill('x-a'), skill('xb'), skill('ax')], 'x')), ['x-a', 'xb', 'b-x', 'ax']);
  });

  it('ignores case in the query and in the names', () => {
    assert.deepEqual(names(filterSkills(skills, 'RE')), ['review', 'revert', 'security-review', 'code-review']);
    assert.deepEqual(names(filterSkills([skill('Deploy'), skill('undeploy')], 'DEP')), ['Deploy', 'undeploy']);
  });

  it('is every skill, in order, for an empty query', () => {
    assert.deepEqual(names(filterSkills(skills, '')), names(skills));
  });

  it('is nothing for a query no name has', () => {
    assert.deepEqual(filterSkills(skills, 'zzz'), []);
  });

  it('hands back the rows themselves, with their descriptions and hints', () => {
    const rows = [skill('simplify', 'Simplify changed code', '[path]')];
    assert.deepEqual(filterSkills(rows, 'sim'), rows);
  });

  it('does not take a query for a pattern', () => {
    assert.deepEqual(filterSkills([skill('a.c'), skill('abc')], 'a.c').map((s) => s.name), ['a.c']);
    assert.deepEqual(filterSkills([skill('abc')], '.*'), []);
  });

  it('leaves out a row with no name, since there is nothing to insert, and survives other missing fields', () => {
    const rows: any[] = [null, {}, { description: 'no name' }, { name: 7 }, { name: 'ok' }, { name: 'okay', description: undefined }];
    assert.deepEqual(names(filterSkills(rows, '')), ['ok', 'okay']);
    assert.deepEqual(names(filterSkills(rows, 'ok')), ['ok', 'okay']);
  });

  it('tolerates a list that is not one', () => {
    assert.deepEqual(filterSkills(undefined as any, 're'), []);
    assert.deepEqual(filterSkills(null as any, ''), []);
  });
});

describe('skillQuery', () => {
  it('is the empty string for a lone slash: every skill', () => {
    assert.equal(skillQuery('/'), '');
  });

  it('is what follows the slash', () => {
    assert.equal(skillQuery('/re'), 're');
    assert.equal(skillQuery('/Review'), 'Review');
  });

  it('is null once a space is typed: the name is chosen and the rest is its argument', () => {
    assert.equal(skillQuery('/re '), null);
    assert.equal(skillQuery('/review the diff'), null);
    assert.equal(skillQuery('/re\n'), null);
  });

  it('is null for text that does not start with a slash', () => {
    assert.equal(skillQuery('x/re'), null);
    assert.equal(skillQuery(' /re'), null);
    assert.equal(skillQuery(''), null);
    assert.equal(skillQuery('re'), null);
  });

  it('reads a second slash as part of the query', () => {
    assert.equal(skillQuery('/a/b'), 'a/b');
  });
});
