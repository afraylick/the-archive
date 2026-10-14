/* eslint-disable @typescript-eslint/no-require-imports */
// Compile the real route handlers with the project's installed TypeScript.
// No server, real credentials, or production storage are used by these tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { test, after } = require('node:test');
const root = path.resolve(__dirname, '..');
const ts = require('typescript');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (name, parent, ...rest) {
  return resolve.call(this, name.startsWith('@/') ? path.join(root, name.slice(2)) : name, parent, ...rest);
};
require.extensions['.ts'] = (mod, filename) => {
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, filename);
};
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'songie-storage-test-'));
const originalCwd = process.cwd();
process.chdir(scratch); // Isolate the legacy ./data paths too.
process.env.NODE_ENV = 'production';
process.env.ARCHIVE_AUTH_SECRET = 'isolated-storage-tests-only';
delete process.env.ARCHIVE_ACCOUNT_CODES;
after(() => { process.chdir(originalCwd); fs.rmSync(scratch, { recursive: true, force: true }); });
const load = name => require(path.join(root, name));
const { NextRequest } = require('next/server');
const storage = load('lib/storage.ts');
const json = load('lib/json-storage.ts');
const auth = load('lib/auth.ts');
const generator = load('lib/server-waveform.ts');
const waveformRoute = load('app/api/files/[id]/waveform/route.ts');
const commentsRoute = load('app/api/files/[id]/comments/route.ts');
const libraryRoute = load('app/api/files/route.ts');
const uploadRoute = load('app/api/upload/route.ts');
const versionRoute = load('app/api/files/[id]/uploads/route.ts');
const deleteRoute = load('app/api/files/[id]/route.ts');
const fixture = { id: 'fixture.wav', name: 'Fixture', ratings: { adam: 0 }, comments: [], collections: [] };
const generated = { waveformPeaks: [Array(4000).fill(.1234)], waveformDuration: 10, generator: 'ffmpeg' };
const context = { params: Promise.resolve({ id: fixture.id }) };
const save = data => json.writeJsonAtomic(storage.getDataFilePath(), data);
const read = () => json.readArchive();
const request = (url, method = 'GET', body) => new NextRequest(`http://test.local${url}`, {
  method,
  headers: { cookie: `archive_session=${auth.createSessionToken('adam')}`, ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
  ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
});
const setup = () => {
  process.env.ARCHIVE_STORAGE_DIR = fs.mkdtempSync(path.join(scratch, 'archive-'));
  storage.ensureStorageDirs();
  auth.getPublicUsers(); // Initialize clean settings before creating data.json.
  fs.writeFileSync(storage.getUploadPath(fixture.id), Buffer.alloc(100));
  save([fixture]);
};
const addComment = async () => {
  const res = await commentsRoute.POST(request('/api/files/fixture.wav/comments', 'POST', { text: 'Concurrent comment' }), context);
  assert.equal(res.status, 200);
};
const pauseGeneration = t => {
  const pending = [];
  t.mock.method(generator, 'generateServerWaveform', () => new Promise(resolve => pending.push(resolve)));
  return {
    async waitFor(count) {
      for (let i = 0; i < 100 && pending.length < count; i++) await new Promise(resolve => setImmediate(resolve));
      assert.equal(pending.length, count, 'processing reached generation');
    },
    finish(index = 0) { pending[index](generated); },
  };
};
const form = (field = 'files') => {
  const body = new FormData();
  const wav = Buffer.alloc(44);
  wav.write('RIFF'); wav.write('WAVE', 8);
  body.append(field, new File([wav], 'fixture.wav', { type: 'audio/wav' }));
  return body;
};

test('archive persistence regressions', async t => {
  await t.test('library GET preserves missing records and leaves bytes unchanged', async () => {
    setup();
    save([{ ...fixture, comments: [{ userId: 'adam', text: 'Legacy comment' }] }, { ...fixture, id: 'missing.wav' }]);
    const before = fs.readFileSync(storage.getDataFilePath(), 'utf8');
    const first = await (await libraryRoute.GET(request('/api/files'))).json();
    const second = await (await libraryRoute.GET(request('/api/files'))).json();
    assert.equal(fs.readFileSync(storage.getDataFilePath(), 'utf8'), before);
    assert.equal(read().length, 2);
    assert.equal(first[0].comments[0].id, second[0].comments[0].id);
  });
  await t.test('legacy comments retain usable IDs after read-only normalization', async () => {
    setup();
    save([{ ...fixture, comments: [{ text: 'old note' }, { userId: 'adam', text: 'Legacy comment' }] }]);
    const files = await (await libraryRoute.GET(request('/api/files'))).json();
    const commentId = files[0].comments[0].id;
    await addComment();
    assert.equal(read()[0].comments[0].id, commentId);
    assert.equal(read()[0].notes, 'old note');
    const response = await commentsRoute.DELETE(request('/comments', 'DELETE', { commentId }), context);
    assert.equal(response.status, 200);
    assert.equal(read()[0].comments.length, 1);
    assert.equal(read()[0].comments[0].text, 'Concurrent comment');
  });
  await t.test('partial temporary writes cannot truncate the committed file', t => {
    setup(); const before = fs.readFileSync(storage.getDataFilePath(), 'utf8');
    const originalWrite = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (target, content, options) => {
      if (typeof target === 'number') {
        originalWrite(target, '{partial');
        throw new Error('simulated disk full');
      }
      return originalWrite(target, content, options);
    });
    assert.throws(() => save([]), /simulated disk full/);
    assert.equal(fs.readFileSync(storage.getDataFilePath(), 'utf8'), before);
    assert.equal(fs.readdirSync(storage.getStorageRoot()).some(name => name.endsWith('.tmp')), false);
  });
  await t.test('generation preserves comments committed while processing', async t => {
    setup(); const gate = pauseGeneration(t);
    const processing = waveformRoute.POST(request('/waveform', 'POST'), context);
    await gate.waitFor(1); await addComment(); gate.finish();
    assert.equal((await processing).status, 200);
    assert.equal(read()[0].comments.length, 1);
    assert.equal(read()[0].waveformDuration, 10);
  });
  await t.test('generation does not resurrect deleted records', async t => {
    setup(); const gate = pauseGeneration(t);
    const processing = waveformRoute.POST(request('/waveform', 'POST'), context);
    await gate.waitFor(1);
    assert.equal((await deleteRoute.DELETE(request('/fixture', 'DELETE'), context)).status, 200);
    gate.finish(); assert.equal((await processing).status, 404); assert.deepEqual(read(), []);
  });
  await t.test('simultaneous batches preserve each other and concurrent comments', async t => {
    setup(); const gate = pauseGeneration(t);
    const first = uploadRoute.POST(request('/api/upload', 'POST', form()));
    const second = uploadRoute.POST(request('/api/upload', 'POST', form()));
    await gate.waitFor(2); await addComment(); gate.finish(1); gate.finish(0);
    assert.equal((await first).status, 200); assert.equal((await second).status, 200);
    assert.equal(read().length, 3); assert.equal(read()[0].comments.length, 1);
  });
  await t.test('version upload preserves concurrent comments', async t => {
    setup(); const gate = pauseGeneration(t);
    const processing = versionRoute.POST(request('/uploads', 'POST', form('file')), context);
    await gate.waitFor(1); await addComment(); gate.finish();
    assert.equal((await processing).status, 201);
    assert.equal(read().length, 2); assert.equal(read()[0].comments.length, 1);
  });
  await t.test('version upload checks the parent at commit time and cleans its file', async t => {
    setup(); const gate = pauseGeneration(t);
    const processing = versionRoute.POST(request('/uploads', 'POST', form('file')), context);
    await gate.waitFor(1);
    await deleteRoute.DELETE(request('/fixture', 'DELETE'), context);
    gate.finish(); assert.equal((await processing).status, 404);
    assert.deepEqual(read(), []); assert.deepEqual(fs.readdirSync(storage.getUploadsDir()), []);
  });
  await t.test('a failed atomic replacement preserves the original and removes temporary files', t => {
    setup(); const before = fs.readFileSync(storage.getDataFilePath(), 'utf8');
    t.mock.method(fs, 'renameSync', () => { throw new Error('simulated failed commit'); });
    assert.throws(() => save([]), /simulated failed commit/);
    assert.equal(fs.readFileSync(storage.getDataFilePath(), 'utf8'), before);
    assert.equal(fs.readdirSync(storage.getStorageRoot()).some(name => name.endsWith('.tmp')), false);
  });
  await t.test('malformed metadata is not silently replaced', () => {
    setup(); fs.writeFileSync(storage.getDataFilePath(), '{broken');
    assert.throws(() => json.updateArchive(current => [...current, fixture]));
    assert.equal(fs.readFileSync(storage.getDataFilePath(), 'utf8'), '{broken');
  });
});
