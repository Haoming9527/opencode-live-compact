const { strict: assert } = require('node:assert');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');

const root = process.env.LIVE_COMPACT_GRADE_ROOT;
const baseline = process.env.LIVE_COMPACT_GRADE_BASELINE;
const api = () => require(root);
const explain = (...args) => api().explainSatisfaction(...args);

test('exports the same function from the root and direct module', () => {
  assert.equal(typeof api().explainSatisfaction, 'function');
  assert.equal(api().explainSatisfaction, require(join(root, 'ranges', 'explain-satisfaction.js')));
  assert.deepEqual(Object.keys(api()).filter(key => key !== 'explainSatisfaction').sort(), Object.keys(require(baseline)).sort());
});

test('validates inputs with version-first precedence', () => {
  for (const invalid of [null, 'broken', '999999999999999999.1.2', 123]) {
    assert.deepEqual(explain(invalid, 'invalid'), { satisfies: false, reason: 'invalid-version', alternatives: [] });
  }
  for (const invalid of [null, 'not a range', 123]) {
    assert.deepEqual(explain('1.2.3', invalid), { satisfies: false, reason: 'invalid-range', alternatives: [] });
  }
});

test('keeps both OR alternatives and actual comparator outcomes', () => {
  assert.deepEqual(explain('2.1.0', '^1 || ~2.1.0'), {
    satisfies: true, reason: 'match', alternatives: [
      { comparators: [{ value: '>=1.0.0', passes: true }, { value: '<2.0.0-0', passes: false }], prereleaseAllowed: true, passes: false },
      { comparators: [{ value: '>=2.1.0', passes: true }, { value: '<2.2.0-0', passes: true }], prereleaseAllowed: true, passes: true },
    ],
  });
  const match = explain('1.0.0', '^1 || ^2');
  assert.equal(match.alternatives.length, 2);
  assert.equal(match.alternatives[0].passes, true);
  assert.equal(match.alternatives[1].passes, false);
});

test('distinguishes prerelease exclusion from comparator failure', () => {
  assert.equal(explain('2.1.0-beta.2', '>1.0.0 <3.0.0').reason, 'prerelease-excluded');
  assert.equal(explain('2.1.0-beta.2', '>3.0.0').reason, 'comparators-mismatch');
  assert.equal(explain('2.1.0-beta.2', '>=2.1.0-beta.1 <3.0.0').reason, 'match');
  assert.equal(explain('2.2.0-beta.2', '>=2.1.0-beta.1 <3.0.0').reason, 'prerelease-excluded');
  assert.equal(explain('2.2.0-beta.2', '>=2.1.0-beta.1 <3.0.0', { includePrerelease: true }).reason, 'match');
  assert.equal(explain('2.2.0-beta.2', '>=2.1.0-beta.1 <3.0.0 || >9.0.0').reason, 'prerelease-excluded');
});

test('handles wildcard, build metadata and legacy loose options', () => {
  assert.deepEqual(explain('1.2.3+demo', ''), { satisfies: true, reason: 'match', alternatives: [
    { comparators: [{ value: '', passes: true }], prereleaseAllowed: true, passes: true },
  ] });
  assert.equal(explain('01.2.3', '^01.2.0', { loose: true }).satisfies, true);
  assert.equal(explain('01.2.3', '^01.2.0', true).satisfies, true);
  assert.equal(explain('01.2.3', '^01.2.0').reason, 'invalid-version');
  assert.equal(explain('1.2.3-beta', '*').reason, 'prerelease-excluded');
  assert.equal(explain('1.2.3-beta', '*', { includePrerelease: true }).reason, 'match');
});

test('agrees with pinned semver across a range/options matrix', () => {
  const original = require(baseline);
  for (const version of ['0.0.0-0', '0.0.0', '0.2.0', '1.0.0-beta.2', '1.0.0', '1.2.3+other', '2.0.0-alpha', '3.4.5', '03.4.5']) {
    for (const range of ['', '*', '1.x', '0.2.0 - 1.0.0', '^1.2', '~2.0.0-alpha', '<3.4.5 >1.0.0 || =3.4.5', '>=1.0.0-beta.1 <2.0.0', '<0.0.0-0 || =0.0.0']) {
      for (const options of [undefined, { loose: true }, { includePrerelease: true }, { loose: true, includePrerelease: true }]) {
        const expected = original.satisfies(version, range, options);
        assert.equal(explain(version, range, options).satisfies, expected, `${version} / ${range} / ${JSON.stringify(options)}`);
        assert.equal(api().satisfies(version, range, options), expected);
      }
    }
  }
});

test('retains existing exports and package dependencies', () => {
  assert.equal(api().validRange('^2.1'), '>=2.1.0 <3.0.0-0');
  assert.equal(api().compare('2.1.0-beta.1', '2.1.0'), -1);
  for (const key of ['name', 'version', 'dependencies', 'devDependencies', 'bin']) {
    assert.deepEqual(require(join(root, 'package.json'))[key], require(join(baseline, 'package.json'))[key]);
  }
  for (const file of ['bin/semver.js', 'classes/range.js', 'classes/semver.js', 'classes/comparator.js', 'functions/satisfies.js']) {
    assert.deepEqual(readFileSync(join(root, file)), readFileSync(join(baseline, file)), `${file} changed`);
  }
});

test('documents API, reasons and detail fields', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const original = readFileSync(join(baseline, 'README.md'), 'utf8');
  assert.ok(readme.length >= original.length);
  for (const term of ['explainSatisfaction', 'invalid-version', 'invalid-range', 'prerelease-excluded', 'comparators-mismatch', 'prereleaseAllowed']) {
    assert.ok(readme.includes(term), `missing ${term}`);
  }
});
