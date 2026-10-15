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
const request = (url, method = 'GET', body, userId = 'adam') => new NextRequest(`http://test.local${url}`, {
  method,
  headers: { cookie: `archive_session=${auth.createSessionToken(userId)}`, ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
  ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
});
const setup = async () => {
  process.env.ARCHIVE_STORAGE_DIR = fs.mkdtempSync(path.join(scratch, 'archive-'));
  storage.ensureStorageDirs();
  auth.getPublicUsers(); // Initialize clean settings before creating data.json.
  await auth.setUserPasscode('adam', 'fixture-admin-password');
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
      for (let i = 0; i < 300 && pending.length < count; i++) await new Promise(resolve => setTimeout(resolve, 10));
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
    await setup();
    save([{ ...fixture, comments: [{ userId: 'adam', text: 'Legacy comment' }] }, { ...fixture, id: 'missing.wav' }]);
    const before = fs.readFileSync(storage.getDataFilePath(), 'utf8');
    const first = await (await libraryRoute.GET(request('/api/files'))).json();
    const second = await (await libraryRoute.GET(request('/api/files'))).json();
    assert.equal(fs.readFileSync(storage.getDataFilePath(), 'utf8'), before);
    assert.equal(read().length, 2);
    assert.equal(first[0].comments[0].id, second[0].comments[0].id);
  });
  await t.test('legacy comments retain usable IDs after read-only normalization', async () => {
    await setup();
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
  await t.test('partial temporary writes cannot truncate the committed file', async t => {
    await setup(); const before = fs.readFileSync(storage.getDataFilePath(), 'utf8');
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
    await setup(); const gate = pauseGeneration(t);
    const processing = waveformRoute.POST(request('/waveform', 'POST'), context);
    await gate.waitFor(1); await addComment(); gate.finish();
    assert.equal((await processing).status, 200);
    assert.equal(read()[0].comments.length, 1);
    assert.equal(read()[0].waveformDuration, 10);
  });
  await t.test('generation does not resurrect deleted records', async t => {
    await setup(); const gate = pauseGeneration(t);
    const processing = waveformRoute.POST(request('/waveform', 'POST'), context);
    await gate.waitFor(1);
    assert.equal((await deleteRoute.DELETE(request('/fixture', 'DELETE'), context)).status, 200);
    gate.finish(); assert.equal((await processing).status, 404); assert.deepEqual(read(), []);
  });
  await t.test('simultaneous batches preserve each other and concurrent comments', async t => {
    await setup(); const gate = pauseGeneration(t);
    const first = uploadRoute.POST(request('/api/upload', 'POST', form()));
    const second = uploadRoute.POST(request('/api/upload', 'POST', form()));
    await gate.waitFor(2); await addComment(); gate.finish(1); gate.finish(0);
    assert.equal((await first).status, 200); assert.equal((await second).status, 200);
    assert.equal(read().length, 3); assert.equal(read()[0].comments.length, 1);
  });
  await t.test('version upload preserves concurrent comments', async t => {
    await setup(); const gate = pauseGeneration(t);
    const processing = versionRoute.POST(request('/uploads', 'POST', form('file')), context);
    await gate.waitFor(1); await addComment(); gate.finish();
    assert.equal((await processing).status, 201);
    assert.equal(read().length, 2); assert.equal(read()[0].comments.length, 1);
  });
  await t.test('version upload checks the parent at commit time and cleans its file', async t => {
    await setup(); const gate = pauseGeneration(t);
    const processing = versionRoute.POST(request('/uploads', 'POST', form('file')), context);
    await gate.waitFor(1);
    await deleteRoute.DELETE(request('/fixture', 'DELETE'), context);
    gate.finish(); assert.equal((await processing).status, 404);
    assert.deepEqual(read(), []); assert.deepEqual(fs.readdirSync(storage.getUploadsDir()), []);
  });
  await t.test('a failed atomic replacement preserves the original and removes temporary files', async t => {
    await setup(); const before = fs.readFileSync(storage.getDataFilePath(), 'utf8');
    t.mock.method(fs, 'renameSync', () => { throw new Error('simulated failed commit'); });
    assert.throws(() => save([]), /simulated failed commit/);
    assert.equal(fs.readFileSync(storage.getDataFilePath(), 'utf8'), before);
    assert.equal(fs.readdirSync(storage.getStorageRoot()).some(name => name.endsWith('.tmp')), false);
  });
  await t.test('malformed metadata is not silently replaced', async () => {
    await setup(); fs.writeFileSync(storage.getDataFilePath(), '{broken');
    assert.throws(() => json.updateArchive(current => [...current, fixture]));
    assert.equal(fs.readFileSync(storage.getDataFilePath(), 'utf8'), '{broken');
  });
});

const stemsRoute = load('app/api/files/[id]/stems/route.ts');
const { proxy } = load('proxy.ts');
const patch = (body, userId) => deleteRoute.PATCH(request('/api/files/fixture.wav', 'PATCH', body, userId), context);
const stemForm = () => {
  const body = new FormData();
  body.append('file', new File(['new zip'], 'new.zip', { type: 'application/zip' }));
  return body;
};
const setupStem = async () => {
  await setup();
  save([{ ...fixture, stems: { id: 'old.zip', name: 'old.zip', uploadedAt: '2020-01-01' } }]);
  fs.writeFileSync(storage.getStemPath('old.zip'), 'original zip');
};

test('targeted edits and attachment lifecycle', async t => {
  await t.test('unrelated edits preserve server-owned fields and concurrent interactions', async () => {
    await setup();
    const original = { ...fixture, originalName: 'original.wav', ratings: { adam: 4, member: 5 }, ratingUpdatedAt: { member: 'recent' }, likedBy: ['member'], collections: ['New collection'], notes: 'original', waveformPeaks: generated.waveformPeaks, waveformDuration: 10, waveformCacheVersion: 6, stems: { id: 'new.zip' } };
    save([original]);
    await addComment();
    assert.equal((await patch({ operation: 'metadata', changes: { name: 'Rename from tab A' } })).status, 200);
    assert.equal((await patch({ operation: 'metadata', changes: { notes: 'Notes from stale tab B' } })).status, 200);
    assert.deepEqual(read()[0], { ...original, name: 'Rename from tab A', notes: 'Notes from stale tab B', comments: read()[0].comments });
    assert.equal(read()[0].comments.length, 1);
  });
  await t.test('legacy whole-record PUT is rejected without changing data', async () => {
    await setup(); await addComment(); const before = read();
    const response = await deleteRoute.PUT(request('/api/files/fixture.wav', 'PUT', { ...fixture, name: 'Stale' }), context);
    assert.equal(response.status, 409); assert.deepEqual(read(), before);
  });
  await t.test('invalid or protected metadata fields are rejected atomically', async () => {
    await setup(); const before = read();
    for (const changes of [{ id: 'other.wav' }, { projectId: 'other.wav' }, { comments: [] }, { ratings: {} }, { stems: null }, { waveformPeaks: [] }, { likedBy: [] }, { collections: [] }, { name: '' }, { notes: 'x'.repeat(10001) }, { year: 1800 }, { year: 2020.5 }, { vibes: [123] }, { defaultVersionId: 'unrelated.wav' }]) {
      assert.equal((await patch({ operation: 'metadata', changes: { name: 'Must not apply', ...changes } })).status, 400);
      assert.deepEqual(read(), before);
    }
  });
  await t.test('metadata aliases and year derive from the latest persisted record', async () => {
    await setup(); save([{ ...fixture, createdAt: '2020-05-06T12:00:00.000Z' }]);
    const response = await patch({ operation: 'metadata', changes: { instruments: ['Guitar'], year: 2024, name: 'Renamed' } });
    assert.equal(response.status, 200);
    assert.equal(read()[0].instrument, 'Guitar');
    assert.equal(read()[0].originalName, 'Fixture');
    assert.equal(read()[0].createdAt, '2024-05-06T12:00:00.000Z');
  });
  await t.test('waveform removal and rating reset are explicit and preserve unrelated data', async () => {
    await setup(); save([{ ...fixture, ...generated, waveformCacheVersion: 6, ratings: { adam: 4, member: 5 }, ratingUpdatedAt: { adam: 'keep', member: 'remove' }, notes: 'keep me' }]);
    assert.equal((await patch({ operation: 'reset-member-ratings' })).status, 200);
    assert.deepEqual(read()[0].ratings, { adam: 4 }); assert.deepEqual(read()[0].ratingUpdatedAt, { adam: 'keep' });
    assert.equal(read()[0].waveformDuration, 10);
    const response = await patch({ operation: 'waveform', waveform: null });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).changes.waveformPeaks, null);
    assert.equal('waveformPeaks' in read()[0], false); assert.equal('waveformDuration' in read()[0], false);
    assert.equal(read()[0].notes, 'keep me'); assert.deepEqual(read()[0].ratings, { adam: 4 });
  });
  await t.test('rating reset preserves legacy administrator ratings', async () => {
    await setup(); save([{ id: fixture.id, name: fixture.name, rating: 5 }]);
    assert.equal((await patch({ operation: 'reset-member-ratings' })).status, 200);
    assert.equal(read()[0].ratings.adam, 5);
    save([{ ...fixture, myRating: 5, ratings: { adam: 0, member: 3 } }]);
    assert.equal((await patch({ operation: 'reset-member-ratings' })).status, 200);
    assert.equal(read()[0].ratings.adam, 0);
  });
  await t.test('deleting a default variation preserves its parent and other recordings', async () => {
    await setup();
    const variant = { ...fixture, id: 'variation.wav', projectId: fixture.id };
    save([{ ...fixture, defaultVersionId: variant.id, notes: 'keep' }, variant]);
    fs.writeFileSync(storage.getUploadPath(variant.id), 'audio');
    const response = await deleteRoute.DELETE(request('/variation', 'DELETE'), { params: Promise.resolve({ id: variant.id }) });
    assert.equal(response.status, 200);
    assert.equal(read().length, 1);
    assert.equal(read()[0].defaultVersionId, fixture.id);
    assert.equal(read()[0].notes, 'keep');
    assert.equal(fs.existsSync(storage.getUploadPath(fixture.id)), true);
    assert.equal(fs.existsSync(storage.getUploadPath(variant.id)), false);
  });
  await t.test('members can cache waveforms but cannot edit metadata reset ratings or cull', async () => {
    await setup(); const member = await auth.createUser('Member', 'member-password');
    for (const mutation of [{ operation: 'metadata', changes: { notes: 'no' } }, { operation: 'reset-member-ratings' }, { operation: 'waveform', waveform: null }]) {
      assert.equal((await patch(mutation, member.id)).status, 403);
    }
    const response = await patch({ operation: 'waveform', waveform: { ...generated, waveformCacheVersion: 6 } }, member.id);
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys((await response.json()).changes).sort(), ['waveformCacheVersion', 'waveformDuration', 'waveformPeaks']);
    const anonymous = new NextRequest('http://test.local/api/files/fixture.wav', { method: 'PATCH', body: '{}' });
    assert.equal((await deleteRoute.PATCH(anonymous, context)).status, 401);
  });
  await t.test('proxy allows own-comment deletion and the route rejects other owners', async () => {
    await setup(); const member = await auth.createUser('Member', 'member-password');
    await addComment();
    const adminComment = read()[0].comments[0].id;
    const posted = await commentsRoute.POST(request('/api/files/fixture.wav/comments', 'POST', { text: 'Member comment' }, member.id), context);
    assert.equal(posted.status, 200); const ownComment = read()[0].comments[1].id;
    const ownRequest = request('/api/files/fixture.wav/comments', 'DELETE', { commentId: ownComment }, member.id);
    assert.equal(proxy(ownRequest).status, 200);
    assert.equal((await commentsRoute.DELETE(ownRequest, context)).status, 200);
    assert.equal((await commentsRoute.DELETE(request('/api/files/fixture.wav/comments', 'DELETE', { commentId: adminComment }, member.id), context)).status, 403);
    assert.equal(proxy(request('/api/files/fixture.wav', 'DELETE', undefined, member.id)).status, 403);
    assert.equal((await deleteRoute.DELETE(request('/api/files/fixture.wav', 'DELETE', undefined, member.id), context)).status, 403);
  });
  await t.test('failed new attachment write preserves the original attachment', async t => {
    await setupStem(); const before = read(); const original = fs.renameSync;
    t.mock.method(fs, 'renameSync', (source, target) => {
      if (typeof target === 'string' && target.startsWith(storage.getStemsDir())) {
        throw new Error('Disk full');
      }
      return original(source, target);
    });
    assert.equal((await stemsRoute.POST(request('/stems', 'POST', stemForm()), context)).status, 500);
    assert.deepEqual(read(), before); assert.deepEqual(fs.readdirSync(storage.getStemsDir()), ['old.zip']);
    assert.equal(fs.readFileSync(storage.getStemPath('old.zip'), 'utf8'), 'original zip');
  });
  await t.test('failed metadata commit rolls back only the new attachment', async t => {
    await setupStem(); const before = read();
    t.mock.method(json, 'writeJsonAtomic', () => { throw new Error('Commit failed'); });
    assert.equal((await stemsRoute.POST(request('/stems', 'POST', stemForm()), context)).status, 500);
    assert.deepEqual(read(), before); assert.deepEqual(fs.readdirSync(storage.getStemsDir()), ['old.zip']);
  });
  await t.test('replacement commits the new reference before cleaning the old file', async t => {
    await setupStem(); const original = fs.rmSync;
    t.mock.method(fs, 'rmSync', (target, options) => {
      if (target === storage.getStemPath('old.zip')) {
        assert.notEqual(read()[0].stems.id, 'old.zip');
        assert.equal(fs.readFileSync(storage.getStemPath(read()[0].stems.id), 'utf8'), 'new zip');
      }
      return original(target, options);
    });
    assert.equal((await stemsRoute.POST(request('/stems', 'POST', stemForm()), context)).status, 200);
    assert.equal(fs.existsSync(storage.getStemPath('old.zip')), false);
  });
  await t.test('failed deletion commits leave original stems and project files intact', async t => {
    await setupStem(); const before = read();
    t.mock.method(json, 'writeJsonAtomic', () => { throw new Error('Commit failed'); });
    assert.equal((await stemsRoute.DELETE(request('/stems', 'DELETE'), context)).status, 500);
    assert.equal((await deleteRoute.DELETE(request('/fixture', 'DELETE'), context)).status, 500);
    assert.deepEqual(read(), before);
    assert.equal(fs.existsSync(storage.getStemPath('old.zip')), true);
    assert.equal(fs.existsSync(storage.getUploadPath(fixture.id)), true);
  });
  await t.test('cleanup failure cannot undo or misreport a committed project deletion', async t => {
    await setupStem();
    t.mock.method(console, 'error', () => {});
    t.mock.method(fs, 'rmSync', () => { assert.deepEqual(read(), []); throw new Error('Cleanup unavailable'); });
    assert.equal((await deleteRoute.DELETE(request('/fixture', 'DELETE'), context)).status, 200);
    assert.deepEqual(read(), []);
    assert.equal(fs.existsSync(storage.getUploadPath(fixture.id)), true);
  });
});

const audioRoute = load('app/api/files/[id]/audio/route.ts');
test('audio ranges serve exact suffix bytes and reject unsatisfiable requests', async () => {
  await setup();
  const bytes = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
  fs.writeFileSync(storage.getUploadPath(fixture.id), bytes);
  for (const [range, status, expected] of [['bytes=-10', 206, bytes.subarray(90)], ['bytes=90-', 206, bytes.subarray(90)], ['bytes=0-999', 206, bytes], ['bytes=100-', 416], ['bytes=-0', 416], ['bytes=20-10', 416]]) {
    const r = request('/api/files/fixture.wav/audio'); r.headers.set('range', range);
    const response = await audioRoute.GET(r, context);
    assert.equal(response.status, status);
    if (expected) assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
    else assert.equal(response.headers.get('content-range'), 'bytes */100');
  }
});

test('MP3 playback streams originals even for stale PCM URLs without invoking ffmpeg', async t => {
  await setup();
  const id = 'fixture.mp3';
  const bytes = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
  save([{ ...fixture, id, waveformDuration: 10, waveformCacheVersion: 6 }]);
  fs.writeFileSync(storage.getUploadPath(id), bytes);
  t.mock.method(load('lib/audio-processing.ts'), 'runFfmpeg', async () => { throw new Error('Playback must not invoke ffmpeg'); });
  const ctx = { params: Promise.resolve({ id }) };
  for (const query of ['', '?format=pcm', '?format=mobile', '?download=1', '?format=mp4', '?format=mp4&download=1']) {
    const response = await audioRoute.GET(request(`/api/files/${id}/audio${query}`), ctx);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  }
  const req = request(`/api/files/${id}/audio?format=pcm`);
  req.headers.set('range', 'bytes=20-39');
  const range = await audioRoute.GET(req, ctx);
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 20-39/100');
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(20, 40));
});

test('sample table playback authenticates, streams ranges, and bypasses wrapping for downloads', async t => {
  await setup();
  const id = 'indexed.mp3';
  save([{ ...fixture, id, originalName: 'Original.mp3' }]);
  const source = Buffer.from('original MP3 bytes');
  fs.writeFileSync(storage.getUploadPath(id), source);
  const header = Buffer.from('virtual header');
  let indexes = 0;
  t.mock.method(load('lib/mp3-mp4.ts'), 'getMp3Container', async () => { indexes++; return { header, sourceSize: source.length }; });
  const ctx = { params: Promise.resolve({ id }) };
  const url = `/api/files/${id}/audio?format=mp4`;
  const anonymous = await audioRoute.GET(new NextRequest(`http://test.local${url}`), ctx);
  assert.equal(anonymous.status, 401); assert.equal(indexes, 0);
  const req = request(url); req.headers.set('range', `bytes=${header.length - 2}-${header.length + 3}`);
  const response = await audioRoute.GET(req, ctx);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-type'), 'audio/mp4');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.concat([header.subarray(-2), source.subarray(0, 4)]));
  const download = await audioRoute.GET(request(`${url}&download=1`), ctx);
  assert.equal(indexes, 1);
  assert.equal(download.headers.get('content-type'), 'audio/mpeg');
  assert.match(download.headers.get('content-disposition'), /Original.mp3/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), source);
});

test('metadata index, waveform isolation and invalidation', async () => {
  await setup();
  save([{ ...fixture, ...generated, waveformCacheVersion: 6 }]);
  const before = fs.readFileSync(storage.getDataFilePath());
  const metadata = await (await libraryRoute.GET(request('/api/files?view=metadata'))).json();
  assert.equal(metadata[0].waveformPeaks, undefined);
  assert.equal(metadata[0].waveformAvailable, true);
  const peaks = await (await waveformRoute.GET(request('/waveform'), context)).json();
  assert.deepEqual(peaks.waveformPeaks, generated.waveformPeaks);
  assert.deepEqual(fs.readFileSync(storage.getDataFilePath()), before);
  save([{ ...fixture, name: 'Updated externally' }]);
  const changed = await (await libraryRoute.GET(request('/api/files?view=metadata'))).json();
  assert.equal(changed[0].name, 'Updated externally');
  assert.equal(changed[0].waveformAvailable, false);
});

test('streamed upload limits and malformed bodies remove temporary files', async () => {
  await setup();
  const { receiveUpload } = load('lib/stream-upload.ts');
  const limits = { files: 1, fileBytes: 10, totalBytes: 10, fileField: 'file' };
  const oversized = new FormData(); oversized.append('file', new Blob([Buffer.alloc(20)]), 'large.wav');
  const encoded = new Response(oversized);
  await assert.rejects(receiveUpload(new Request('http://test/upload', { method: 'POST', body: await encoded.arrayBuffer(), headers: encoded.headers }), limits), /too large/);
  const malformed = new Request('http://test/upload', { method: 'POST', body: 'broken', headers: { 'content-type': 'multipart/form-data; boundary=bad' } });
  await assert.rejects(receiveUpload(malformed, limits));
  assert.equal(fs.readdirSync(storage.getStorageRoot()).some(name => name.startsWith('.incoming-')), false);
  const small = new FormData(); small.append('file', new Blob(['abc']), 'small.wav');
  const staged = await receiveUpload(new Request('http://test/upload', { method: 'POST', body: small }), limits);
  assert.equal(fs.readFileSync(staged.files[0].path, 'utf8'), 'abc'); staged.cleanup();
  assert.equal(globalThis.archiveUploadsActive, 0);
});

test('simultaneous mobile ranges share one transcode and release its slot', async t => {
  await setup();
  const processing = load('lib/audio-processing.ts');
  let calls = 0;
  t.mock.method(processing, 'runFfmpeg', async args => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 30));
    fs.writeFileSync(args.at(-1), Buffer.alloc(100, 7));
  });
  const responses = await Promise.all(Array.from({ length: 4 }, () => audioRoute.GET(request('/api/files/fixture.wav/audio?format=mobile'), context)));
  for (const response of responses) { assert.equal(response.status, 200); await response.arrayBuffer(); }
  assert.equal(calls, 1);
  assert.equal(globalThis.archiveTranscodes.size, 0);
});

const collectionRoute = load('app/api/collections/route.ts');
const recordingCollectionsRoute = load('app/api/files/[id]/collections/route.ts');
test('collection names persist across projects and variations', async () => {
  await setup();
  save([
    { ...fixture, notes: 'Keep notes', collections: ['Demos, 2026', 'Other'] },
    { ...fixture, id: 'version.wav', projectId: fixture.id, collections: ['Demos, 2026', 'Renamed'] },
    { ...fixture, id: 'unrelated.wav', collections: ['Unrelated'] },
  ]);
  const response = await collectionRoute.PATCH(request('/api/collections', 'PATCH', { collection: 'Demos, 2026', name: 'Renamed' }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).filesUpdated, 2);
  assert.deepEqual(read().map(file => file.collections), [['Demos, 2026', 'Other'], ['Demos, 2026', 'Renamed'], ['Unrelated']], 'renaming preserves stable membership keys');
  assert.equal(read()[0].notes, 'Keep notes');
  const assigned = await recordingCollectionsRoute.PUT(request('/api/files/fixture.wav/collections', 'PUT', { collections: ['Renamed', 'Other', 'New, collection'] }), context);
  assert.equal(assigned.status, 200);
  const collections = load('lib/collections.ts');
  const catalog = collections.readCollections();
  const renamed = catalog.find(collection => collection.name === 'Renamed');
  assert.deepEqual(collections.collectionTrackIds(renamed), [fixture.id, 'version.wav']);
  assert.equal(catalog.some(collection => collection.name === 'New, collection' && collection.ownerId === 'adam'), true);
  assert.deepEqual((await (await libraryRoute.GET(request('/api/files?view=metadata'))).json())[0].collections, ['Renamed', 'Other', 'New, collection']);
});


const collectionDetailRoute = load('app/api/collections/[id]/route.ts');
const collectionChatRoute = load('app/api/collections/[id]/comments/route.ts');
const ratingsRoute = load('app/api/files/[id]/rating/route.ts');
test('playlist privacy, sharing, ordering, and collaborative ratings', async t => {
  await setup();
  const owner = await auth.createUser('Playlist owner', 'playlist-owner-password');
  const invited = await auth.createUser('Invited listener', 'playlist-invited-password');
  const outsider = await auth.createUser('Other listener', 'playlist-outsider-password');
  save([{ ...fixture, likedBy: [owner.id], ratings: { adam: 4, [owner.id]: 3, [invited.id]: 5, [outsider.id]: 2 } }, { ...fixture, id: 'second.wav', name: 'Second song' }]);
  fs.writeFileSync(storage.getUploadPath('second.wav'), 'audio');
  const created = await collectionRoute.POST(request('/api/collections', 'POST', { name: 'New playlist' }, owner.id));
  assert.equal(created.status, 201);
  const initial = (await created.json()).collection;
  assert.equal(initial.visibility, 'public');
  assert.equal(initial.ownerId, owner.id);
  const ctx = { params: Promise.resolve({ id: initial.id }) };
  const update = (body, userId = owner.id) => collectionDetailRoute.PATCH(request('/collection', 'PATCH', body, userId), ctx);
  const detail = userId => collectionDetailRoute.GET(request('/collection', 'GET', undefined, userId), ctx);
  const list = async userId => (await (await collectionRoute.GET(request('/api/collections', 'GET', undefined, userId))).json()).collections;
  await t.test('all members can create; public defaults are accessible but settings belong to the creator', async () => {
    assert.equal((await detail(outsider.id)).status, 200);
    assert.equal((await update({ name: 'Take over' }, outsider.id)).status, 403);
    assert.equal((await update({ addSongId: fixture.id }, outsider.id)).status, 403);
    assert.equal((await update({ addSongId: fixture.id })).status, 200);
    assert.equal((await update({ addSongId: 'second.wav' })).status, 200);
    assert.equal((await update({ addSongId: fixture.id })).status, 200);
    assert.deepEqual((await (await detail(owner.id)).json()).collection.songIds, [fixture.id, 'second.wav']);
  });
  await t.test('private collections hide their names, content and chat even from uninvited administrators', async () => {
    assert.equal((await update({ visibility: 'private', memberIds: [invited.id] })).status, 200);
    for (const userId of [outsider.id, 'adam']) {
      assert.equal((await detail(userId)).status, 404);
      assert.equal((await list(userId)).some(collection => collection.id === initial.id), false);
      const library = await (await libraryRoute.GET(request('/api/files?view=metadata', 'GET', undefined, userId))).json();
      assert.equal(library[0].collections.includes('New playlist'), false);
      assert.equal((await libraryRoute.GET(request(`/api/files?view=metadata&collection=${initial.id}`, 'GET', undefined, userId))).status, 404);
      assert.equal((await collectionChatRoute.POST(request('/chat', 'POST', { text: 'Unauthorized' }, userId), ctx)).status, 404);
      assert.equal((await recordingCollectionsRoute.PUT(request('/file', 'PUT', { collections: ['New playlist'] }, userId), context)).status, 400);
    }
    const before = read()[0].collections;
    assert.equal((await recordingCollectionsRoute.PUT(request('/file', 'PUT', { collections: [] }, outsider.id), context)).status, 200);
    assert.deepEqual(read()[0].collections, before, 'hidden memberships survive a visible-only edit');
  });
  await t.test('invited users see all ratings only in the private playlist and can edit their own rating', async () => {
    const regular = await (await libraryRoute.GET(request('/api/files?view=metadata', 'GET', undefined, invited.id))).json();
    assert.equal(regular[0].ratings[owner.id], undefined);
    const shared = await (await libraryRoute.GET(request(`/api/files?view=metadata&collection=${initial.id}`, 'GET', undefined, invited.id))).json();
    assert.equal(shared[0].ratings[owner.id], 3);
    assert.equal(shared[0].ratings[outsider.id], 2);
    assert.deepEqual(shared[0].likedBy, [], 'shared rating access does not broaden like visibility');
    const rated = await ratingsRoute.PUT(request(`/api/files/fixture.wav/rating?collection=${initial.id}`, 'PUT', { rating: 1, userId: owner.id }, invited.id), context);
    assert.equal(rated.status, 200);
    const ratings = (await rated.json()).ratings;
    assert.equal(ratings[owner.id], 3, 'members cannot overwrite another member rating');
    assert.equal(ratings[invited.id], 1);
    const wrongContext = await ratingsRoute.PUT(request(`/api/files/fixture.wav/rating?collection=${initial.id}`, 'PUT', { rating: 2 }, outsider.id), context);
    assert.equal((await wrongContext.json()).ratings[owner.id], undefined);
  });
  await t.test('collaborators reorder songs, share messages, and cannot alter owner-only settings', async () => {
    assert.equal((await update({ moveSongId: 'second.wav', direction: 'up' }, invited.id)).status, 200);
    const songs = await (await libraryRoute.GET(request(`/api/files?view=metadata&collection=${initial.id}`, 'GET', undefined, invited.id))).json();
    assert.deepEqual(songs.map(song => song.id), ['second.wav', fixture.id]);
    assert.equal((await update({ visibility: 'public' }, invited.id)).status, 403);
    const posted = await collectionChatRoute.POST(request('/chat', 'POST', { text: 'Keep the second take' }, invited.id), ctx);
    assert.equal(posted.status, 200);
    const comment = (await posted.json()).comments[0];
    assert.equal(comment.userId, invited.id);
    assert.equal((await collectionChatRoute.DELETE(request('/chat', 'DELETE', { commentId: comment.id }, outsider.id), ctx)).status, 404);
    assert.equal((await collectionChatRoute.DELETE(request('/chat', 'DELETE', { commentId: comment.id }, owner.id), ctx)).status, 200);
    assert.equal((await update({ removeSongId: 'second.wav' }, invited.id)).status, 200);
    assert.equal(read().some(file => file.id === 'second.wav'), true, 'removing a song never deletes the recording');
  });
  await t.test('renaming preserves privacy and playlist URLs; revocation closes access', async () => {
    const before = fs.readFileSync(storage.getDataFilePath(), 'utf8');
    assert.equal((await update({ name: 'Private works in progress' })).status, 200);
    assert.equal(fs.readFileSync(storage.getDataFilePath(), 'utf8'), before, 'rename is a single metadata commit');
    assert.equal((await list(outsider.id)).some(collection => collection.name.includes('Private')), false);
    assert.equal((await (await detail(invited.id)).json()).collection.name, 'Private works in progress');
    assert.equal((await update({ memberIds: [] })).status, 200);
    assert.equal((await detail(invited.id)).status, 404);
    assert.equal((await collectionChatRoute.POST(request('/chat', 'POST', { text: 'Revoked' }, invited.id), ctx)).status, 404);
  });
  await t.test('song collection edits retain waveform caches and unrelated metadata', async () => {
    save(read().map(record => record.id === fixture.id ? { ...record, ...generated, waveformCacheVersion: 6, notes: 'Keep notes' } : record));
    const updated = await recordingCollectionsRoute.PUT(request('/file', 'PUT', { collections: ['Private works in progress', 'Another playlist'] }, owner.id), context);
    assert.equal(updated.status, 200);
    assert.deepEqual(read()[0].waveformPeaks, generated.waveformPeaks);
    assert.equal(read()[0].notes, 'Keep notes');
    assert.equal(read()[0].ratings[owner.id], 3);
  });
  await t.test('a failed private rename preserves the old name and never re-exposes legacy memberships', async t => {
    const original = fs.renameSync;
    t.mock.method(fs, 'renameSync', (source, target) => {
      if (target === path.join(storage.getStorageRoot(), 'collections.json')) throw new Error('Simulated collection storage failure');
      return original(source, target);
    });
    assert.equal((await update({ name: 'Must not be public' })).status, 400);
    assert.equal((await (await detail(owner.id)).json()).collection.name, 'Private works in progress');
    assert.equal((await list(outsider.id)).some(collection => collection.id === initial.id), false);
  });
  await t.test('invalid sharing and malformed memberships cannot partially mutate a playlist', async () => {
    const before = fs.readFileSync(path.join(storage.getStorageRoot(), 'collections.json'), 'utf8');
    assert.equal((await update({ name: 'Must not change', visibility: 'unlisted' })).status, 400);
    assert.equal((await update({ name: 'Must not change', memberIds: ['missing-user'] })).status, 400);
    assert.equal(fs.readFileSync(path.join(storage.getStorageRoot(), 'collections.json'), 'utf8'), before);
    assert.equal((await recordingCollectionsRoute.PUT(request('/file', 'PUT', { collections: [123] }, owner.id), context)).status, 400);
    assert.equal((await collectionRoute.POST(new NextRequest('http://test.local/api/collections', { method: 'POST', body: '{}' }))).status, 401);
  });
});
