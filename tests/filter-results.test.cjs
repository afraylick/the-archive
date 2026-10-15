/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');

require.extensions['.ts'] = (mod, filename) => {
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
};
const { reconcileFilterResults } = require(path.join(__dirname, '../lib/use-stable-filter-results.ts'));

const update = (previous, key, files, matches) => reconcileFilterResults(
  previous, key, files.filter(matches).map(file => file.id), new Set(files.map(file => file.id)),
);
const untagged = file => !file.instruments.length && !file.vibes.length;

test('adding multiple tags keeps an untagged result available for continued editing', () => {
  let files = [{ id: 'demo', instruments: [], vibes: [] }];
  let results = update({ key: '', ids: [] }, 'untagged', files, untagged);
  files = [{ ...files[0], instruments: ['Guitar'] }];
  results = update(results, 'untagged', files, untagged);
  assert.deepEqual(results.ids, ['demo']);
  files = [{ ...files[0], vibes: ['Dreamy'] }];
  results = update(results, 'untagged', files, untagged);
  assert.deepEqual(results.ids, ['demo']);
  assert.deepEqual(files.find(file => file.id === results.ids[0]).vibes, ['Dreamy']);
});

test('changing a filter or search reapplies current metadata and drops retained results', () => {
  const files = [{ id: 'demo', instruments: ['Guitar'], vibes: [] }];
  const retained = { key: 'untagged', ids: ['demo'] };
  const changed = update(retained, 'untagged+search', files, untagged);
  assert.deepEqual(changed.ids, []);
  assert.deepEqual(update(changed, 'untagged', files, untagged).ids, []);
});

test('rating and title edits preserve positions until the sort changes', () => {
  const ids = new Set(['first', 'second']);
  const retained = { key: 'rating-desc', ids: ['first', 'second'] };
  const edited = reconcileFilterResults(retained, 'rating-desc', ['second', 'first'], ids);
  assert.strictEqual(edited, retained);
  assert.deepEqual(reconcileFilterResults(edited, 'rating-asc', ['second', 'first'], ids).ids, ['second', 'first']);
});

test('random results retain edited picks without introducing other library songs', () => {
  const available = new Set(['picked', 'other']);
  const retained = { key: 'random-pick-1', ids: ['picked'] };
  assert.deepEqual(reconcileFilterResults(retained, 'random-pick-1', [], available).ids, ['picked']);
  assert.deepEqual(reconcileFilterResults(retained, 'random-pick-2', ['other'], available).ids, ['other']);
});

test('deleted songs disappear and newly matching songs are added without duplicates', () => {
  const retained = { key: 'liked', ids: ['deleted', 'kept'] };
  const available = new Set(['kept', 'new', 'excluded']);
  const results = reconcileFilterResults(retained, 'liked', ['kept', 'new'], available);
  assert.deepEqual(results.ids, ['kept', 'new']);
  assert.strictEqual(reconcileFilterResults(results, 'liked', ['kept', 'new'], available), results);
});
