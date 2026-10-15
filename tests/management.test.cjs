/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const { collectionNames, projectInCollection, renameManagedCollection, replaceManagedRecording, metadataEdits } = require(path.join(__dirname, '../lib/management.ts'));

test('collections retain exact names and include variation-only membership', () => {
  const files = [{ id: 'one', name: 'One', collections: ['Demos, 2026', 'Live'], uploads: [{ id: 'version', name: 'Version', collections: ['Variations'] }] }];
  assert.deepEqual(collectionNames(files), ['Demos, 2026', 'Live', 'Variations']);
  assert.equal(projectInCollection(files[0], 'Variations'), true);
  assert.equal(projectInCollection(files[0], 'Demos'), false);
});

test('renaming a collection updates all versions and merges membership without changing audio or notes', () => {
  const files = [{ id: 'one', name: 'One', notes: 'Keep', collections: ['Old', 'Existing', 'Other'], uploads: [{ id: 'version', name: 'Version', collections: ['Old'], waveformDuration: 12 }] }];
  const result = renameManagedCollection(files, 'Old', 'Existing');
  assert.deepEqual(result[0].collections, ['Existing', 'Other']);
  assert.deepEqual(result[0].uploads[0].collections, ['Existing']);
  assert.equal(result[0].notes, 'Keep');
  assert.equal(result[0].uploads[0].waveformDuration, 12);
  assert.deepEqual(files[0].collections, ['Old', 'Existing', 'Other']);
});

test('targeted committed fields preserve other projects and versions', () => {
  const files = [{ id: 'one', name: 'One', collections: ['Keep'], uploads: [{ id: 'version', name: 'Version', notes: 'Keep too' }] }];
  const result = replaceManagedRecording(files, 'version', { finish: 'Recorder' });
  assert.deepEqual(result[0].collections, ['Keep']);
  assert.equal(result[0].uploads[0].notes, 'Keep too');
  assert.equal(result[0].uploads[0].finish, 'Recorder');
});

test('saving one field never submits unchanged metadata or collection membership', () => {
  const before = { id: 'one', name: 'One', notes: 'Keep', year: 2025, instruments: ['Guitar'], vibes: ['Ambient'], collections: ['Keep'] };
  assert.deepEqual(metadataEdits(before, { ...before }), {});
  assert.deepEqual(metadataEdits(before, { ...before, finish: 'Tracked' }), { finish: 'Tracked' });
  assert.deepEqual(metadataEdits(before, { ...before, instruments: [] }), { instruments: [] });
});
