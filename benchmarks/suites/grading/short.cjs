const { strict: assert } = require('node:assert');
const { join } = require('node:path');
const { test } = require('node:test');

const exercise = (name) => require(join(process.env.LIVE_COMPACT_GRADE_ROOT, `${name}.cjs`));

test('group-by', () => {
  const groupBy = exercise('group-by');
  const key = {};
  const calls = [];
  const values = (function* () { yield 5; yield 4; yield 5; })();
  const grouped = groupBy(values, (value, index) => { calls.push([value, index]); return value === 5 ? key : 'even'; });
  assert.deepEqual([...grouped], [[key, [5, 5]], ['even', [4]]]);
  assert.equal([...grouped.keys()][0], key);
  assert.deepEqual(calls, [[5, 0], [4, 1], [5, 2]]);
  assert.deepEqual(groupBy([], String), new Map());
});

test('dedent', () => {
  const dedent = exercise('dedent');
  assert.equal(dedent('\r\n\t a  \r\n \r\n\t  b\r\n'), 'a  \n\n b');
  assert.equal(dedent('\t a\n  b'), '\t a\n  b');
  assert.equal(dedent('\n\n  a\n\n\n'), '\na\n\n');
  assert.equal(dedent(''), '');
});

test('merge-intervals', () => {
  const mergeIntervals = exercise('merge-intervals');
  const intervals = Object.freeze([[4, 6], [1, 2], [2, 4], [9, 9]].map(Object.freeze));
  const merged = mergeIntervals(intervals);
  assert.deepEqual(merged, [[1, 6], [9, 9]]);
  assert.notEqual(merged[1], intervals[3]);
  assert.deepEqual(mergeIntervals([]), []);
  for (const bad of [[4, 1], [NaN, 0], [0, Infinity]]) assert.throws(() => mergeIntervals([bad]), RangeError);
});

test('parse-fields', () => {
  const parseFields = exercise('parse-fields');
  assert.deepEqual(parseFields(' ,a\\,b,\\\\,,\\🧪'), [' ', 'a,b', '\\', '', '🧪']);
  assert.deepEqual(parseFields(''), ['']);
  assert.deepEqual(parseFields(','), ['', '']);
  assert.throws(() => parseFields('a\\'), SyntaxError);
});

test('topological-order', () => {
  const topologicalOrder = exercise('topological-order');
  const dependencies = new Map([['package', new Set(['compile', 'docs'])], ['compile', ['generate']], ['docs', []], ['sign', ['package']]]);
  assert.deepEqual(topologicalOrder(dependencies), ['generate', 'compile', 'docs', 'package', 'sign']);
  assert.throws(() => topologicalOrder(new Map([['x', ['y']], ['y', ['x']]])), RangeError);
  assert.throws(() => topologicalOrder(new Map([['x', ['x']]])), RangeError);
  assert.deepEqual(topologicalOrder(new Map()), []);
});

test('count-words', () => {
  const countWords = exercise('count-words');
  assert.deepEqual([...countWords('CAFÉ cafe\u0301 naïve3NAÏVE \u0301 🙂 Ἀθήνα')], [['café', 2], ['naïve', 2], ['ἀθήνα', 1]]);
  assert.deepEqual(countWords('123 \u0301'), new Map());
});
