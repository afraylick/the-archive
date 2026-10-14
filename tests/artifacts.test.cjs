/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('artifact guard checks proxy traces, external storage, symlinks and public files', async t => {
  const { inspectBuild } = await import('../scripts/check-build-artifacts.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'songie-artifact-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const build = path.join(root, '.next');
  fs.mkdirSync(path.join(build, 'server'), { recursive: true });
  fs.writeFileSync(path.join(build, 'BUILD_ID'), 'fixture');
  const trace = path.join(build, 'server', 'middleware.js.nft.json');
  const save = files => fs.writeFileSync(trace, JSON.stringify({ version: 1, files }));
  save(['../../node_modules/next/server.js']);
  assert.deepEqual(inspectBuild(root).findings, []);
  for (const entry of ['../../data/recording.wav', '../../.env.production', '../../data/users.json', '../../custom/accounts.json']) {
    save([entry]); assert.equal(inspectBuild(root).findings.length, 1);
  }
  const external = path.join(root, 'external-storage'); fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'private.txt'), 'fixture');
  save(['../../external-storage/private.txt']);
  assert.equal(inspectBuild(root, external).findings.length, 1);
  fs.symlinkSync(path.join(external, 'private.txt'), path.join(root, 'alias.txt'));
  save(['../../alias.txt']); assert.equal(inspectBuild(root, external).findings.length, 1);
  save([]); fs.mkdirSync(path.join(root, 'public'));
  fs.writeFileSync(path.join(root, 'public', 'users.json'), '{}');
  assert.equal(inspectBuild(root).findings.length, 1);
  fs.writeFileSync(trace, '{'); assert.throws(() => inspectBuild(root));
});

test('artifact guard rejects missing production builds or traces', async t => {
  const { inspectBuild } = await import('../scripts/check-build-artifacts.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'songie-artifact-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => inspectBuild(root), /No completed/);
  fs.mkdirSync(path.join(root, '.next')); fs.writeFileSync(path.join(root, '.next', 'BUILD_ID'), 'fixture');
  assert.throws(() => inspectBuild(root), /No production file traces/);
});
