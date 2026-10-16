/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { test, after } = require('node:test');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (name, parent, ...rest) { return resolve.call(this, name.startsWith('@/') ? path.join(root, name.slice(2)) : name, parent, ...rest); };
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'songie-collaborative-'));
const cwd = process.cwd(); process.chdir(scratch);
process.env.NODE_ENV = 'production'; process.env.ARCHIVE_AUTH_SECRET = 'isolated-collaborative-test-secret';
process.env.ARCHIVE_STORAGE_DIR = path.join(scratch, 'storage');
delete process.env.ARCHIVE_ACCOUNT_CODES;
after(() => { process.chdir(cwd); fs.rmSync(scratch, { recursive: true, force: true }); });
const load = name => require(path.join(root, name));
const { NextRequest } = require('next/server');
const auth = load('lib/auth.ts');
const json = load('lib/json-storage.ts');
const storage = load('lib/storage.ts');
const archives = load('lib/archives.ts');
const registry = load('app/api/archives/route.ts');
const library = load('app/api/files/route.ts');
const recording = load('app/api/files/[id]/route.ts');
const collection = load('app/api/collections/route.ts');
const playlist = load('app/api/collections/[id]/route.ts');
const inbox = load('app/api/inbox/route.ts');
const generator = load('lib/server-waveform.ts');
const upload = load('app/api/upload/route.ts');
const version = load('app/api/files/[id]/uploads/route.ts');
const route = kind => load(`app/api/files/[id]/${kind}/route.ts`);
const ctx = id => ({ params: Promise.resolve({ id }) });
function request(url, user = 'adam', method = 'GET', body) {
  return new NextRequest(`http://test.local${url}`, { method, headers: user ? { cookie: `archive_session=${auth.createSessionToken(user)}` } : {}, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) });
}
const data = () => json.readArchive();
const save = records => json.writeJsonAtomic(storage.getDataFilePath(), records);
const listed = async (user, suffix = '') => (await library.GET(request(`/api/files?view=metadata${suffix}`, user))).json();
const share = (id, memberIds, user = id) => registry.PATCH(request('/api/archives', user, 'PATCH', { id, memberIds }));
const mutate = (id, user, changes) => recording.PATCH(request(`/api/files/${id}`, user, 'PATCH', { operation: 'metadata', changes }), ctx(id));
function audioForm(field) {
  const form = new FormData(); const wav = Buffer.alloc(44); wav.write('RIFF'); wav.write('WAVE', 8);
  form.append(field, new File([wav], 'new.wav', { type: 'audio/wav' })); return form;
}

test('collaborative archive boundaries and collection-scoped grants', async t => {
  storage.ensureStorageDirs(); auth.getPublicUsers();
  await auth.setUserPasscode('adam', 'owner-password');
  save([{ id: 'legacy.wav', name: 'Legacy Adam song', notes: 'Keep legacy notes' }]);
  fs.writeFileSync(storage.getUploadPath('legacy.wav'), 'legacy');
  const before = fs.readFileSync(storage.getDataFilePath());
  const alice = await auth.createUser('Alice', 'alice-password');
  const bob = await auth.createUser('Bob', 'bob-password');
  const eve = await auth.createUser('Eve', 'eve-password');
  auth.setUserRole('adam', eve.id, 'admin');
  await t.test('migration leaves recordings untouched and new users do not inherit Adam access', async () => {
    assert.deepEqual(fs.readFileSync(storage.getDataFilePath()), before);
    assert.equal(archives.recordingArchiveId(data()[0]), 'adam');
    assert.deepEqual(await listed(alice.id), []);
    assert.deepEqual((await (await registry.GET(request('/api/archives', alice.id))).json()).archives, []);
    assert.deepEqual((await listed('adam')).map(r => r.id), ['legacy.wav']);
  });
  await t.test('members create one private archive; others cannot rename it or change its access', async () => {
    assert.equal((await registry.POST(request('/api/archives', alice.id, 'POST', { name: "Alice's Archive" }))).status, 201);
    assert.equal((await registry.POST(request('/api/archives', alice.id, 'POST', {}))).status, 409);
    assert.equal((await share(alice.id, [bob.id], bob.id)).status, 403);
    assert.equal((await share(alice.id, [bob.id], 'adam')).status, 403);
    assert.deepEqual(archives.readArchives().find(a => a.id === alice.id).memberIds, []);
    assert.equal((await share(alice.id, ['missing'])).status, 400);
    assert.equal((await registry.POST(request('/api/archives', bob.id, 'POST', {}))).status, 201);
  });
  const base = { archiveId: alice.id, ratings: { [alice.id]: 4, [bob.id]: 3 }, comments: [], collections: [], notes: 'Alice notes', waveformPeaks: [[0, .3]], waveformDuration: 1, waveformCacheVersion: 6 };
  save([...data(), { ...base, id: 'alice.wav', name: 'Alice song', uploadedBy: alice.id, stems: { id: 'alice.zip', name: 'Alice stems.zip' } }, { ...base, id: 'take.wav', projectId: 'alice.wav', name: 'Only this take', notes: 'Version notes' }, { ...base, id: 'sibling.wav', projectId: 'alice.wav', name: 'Secret sibling' }, { id: 'bob.wav', archiveId: bob.id, name: 'Bob song', uploadedBy: bob.id, collections: [] }]);
  for (const id of ['alice.wav', 'take.wav', 'sibling.wav', 'bob.wav']) fs.writeFileSync(storage.getUploadPath(id), 'audio');
  fs.writeFileSync(storage.getStemPath('alice.zip'), 'zip');
  await t.test('libraries and metadata edits stay separate, including for site administrators', async () => {
    assert.deepEqual((await listed(alice.id)).map(r => r.id), ['alice.wav']);
    assert.deepEqual(await listed(bob.id, '&archive=alice'), []);
    assert.equal((await mutate('alice.wav', alice.id, { instruments: ['Synth'], notes: 'New Alice notes' })).status, 200);
    for (const user of [bob.id, eve.id, 'adam']) assert.equal((await mutate('alice.wav', user, { notes: 'No' })).status, 403);
    assert.equal(data().find(r => r.id === 'legacy.wav').notes, 'Keep legacy notes');
    const accountSummaries = await (await load('app/api/users/route.ts').GET(request('/api/users', eve.id))).json();
    assert.equal(accountSummaries.users.some(user => [...user.ratedSongs, ...user.likedSongs, ...user.commentedSongs].some(song => song.id === 'alice.wav')), false, 'site account summaries cannot leak recordings outside accessible archives');
  });
  await t.test('an owner uploads and rates their own recordings without global administrator privileges', async t => {
    t.mock.method(generator, 'generateServerWaveform', async () => ({ waveformPeaks: [[.1]], waveformDuration: 1 }));
    const form = audioForm('files'); form.append('metadata[0]', JSON.stringify({ rating: 5, instruments: ['Guitar'] }));
    const response = await upload.POST(request('/api/upload?archive=alice', alice.id, 'POST', form));
    assert.equal(response.status, 200);
    const id = (await response.json()).results[0].id;
    const record = data().find(r => r.id === id);
    assert.equal(record.archiveId, alice.id); assert.equal(record.uploadedBy, alice.id);
    assert.deepEqual(record.ratings, { [alice.id]: 5 });
    assert.deepEqual(record.instruments, ['Guitar']);
    assert.equal((await upload.POST(request('/api/upload?archive=alice', bob.id, 'POST', audioForm('files')))).status, 403);
    assert.equal((await recording.DELETE(request(`/api/files/${id}`, alice.id, 'DELETE'), ctx(id))).status, 200);
  });
  await t.test('owner Finder-tag import stays within the selected archive', async () => {
    const form = new FormData();
    form.append('file', new File([JSON.stringify({ files: [{ name: 'Alice song', colorTags: ['red'] }, { name: 'Legacy Adam song', colorTags: ['red'] }] })], 'tags.json', { type: 'application/json' }));
    const response = await load('app/api/finder-tags/import/route.ts').POST(request('/api/finder-tags/import?archive=alice', alice.id, 'POST', form));
    assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.matched, 1);
    assert.equal(data().find(record => record.id === 'legacy.wav').colorTags, undefined);
  });
  await t.test('access grants browsing and versions; contributors can tag only their own versions', async t => {
    assert.equal((await share(alice.id, [bob.id])).status, 200);
    const shared = await listed(bob.id, '&archive=alice'); assert.equal(shared[0].canEdit, false);
    assert.equal((await mutate('alice.wav', bob.id, { vibes: ['No'] })).status, 403);
    t.mock.method(generator, 'generateServerWaveform', async () => ({ waveformPeaks: [[.1]], waveformDuration: 1 }));
    const response = await version.POST(request('/api/files/alice.wav/uploads', bob.id, 'POST', audioForm('file')), ctx('alice.wav'));
    assert.equal(response.status, 201); const added = (await response.json()).upload;
    assert.equal(added.archiveId, alice.id); assert.equal(added.canEdit, true);
    assert.equal((await mutate(added.id, bob.id, { instruments: ['Vocals'] })).status, 200);
    assert.equal((await mutate('take.wav', bob.id, { instruments: ['No'] })).status, 403);
  });
  let shared;
  await t.test('collections combine accessible source archives and default to private', async () => {
    const response = await collection.POST(request('/api/collections', bob.id, 'POST', { name: 'Mixed collection', memberIds: [eve.id] }));
    assert.equal(response.status, 201); shared = (await response.json()).collection;
    assert.equal(shared.visibility, 'private');
    for (const id of ['alice.wav', 'bob.wav']) assert.equal((await playlist.PATCH(request('/playlist', bob.id, 'PATCH', { addSongId: id }), ctx(shared.id))).status, 200);
    const files = await listed(eve.id, `&collection=${shared.id}`);
    assert.deepEqual(new Set(files.map(r => r.archiveId)), new Set([alice.id, bob.id]));
    assert.deepEqual(await listed(eve.id), []);
    assert.equal((await playlist.PATCH(request('/playlist', eve.id, 'PATCH', { addSongId: 'legacy.wav' }), ctx(shared.id))).status, 403);
    assert.deepEqual((await listed(bob.id, '&scope=accessible')).map(r => r.id).sort(), ['alice.wav', 'bob.wav']);
  });
  await t.test('collection-only listeners need collection context for audio, waveform, stems and interactions', async () => {
    for (const [kind, method, body] of [['audio', 'GET'], ['waveform', 'GET'], ['stems', 'GET'], ['comments', 'POST', { text: 'Good song' }], ['rating', 'PUT', { rating: 2, userId: alice.id }], ['like', 'PUT', { liked: true }]]) {
      assert.equal((await route(kind)[method](request(`/api/files/alice.wav/${kind}`, eve.id, method, body), ctx('alice.wav'))).status, 403, kind);
      const response = await route(kind)[method](request(`/api/files/alice.wav/${kind}?collection=${shared.id}`, eve.id, method, body), ctx('alice.wav'));
      assert.equal(response.status, 200, kind); if (['audio', 'stems'].includes(kind)) await response.arrayBuffer();
    }
    assert.equal(data().find(r => r.id === 'alice.wav').ratings[alice.id], 4, 'site admins cannot impersonate the owner of another archive');
    assert.equal((await mutate('alice.wav', eve.id, { notes: 'No' })).status, 403);
    assert.equal((await route('collections').PUT(request(`/api/files/alice.wav/collections?collection=${shared.id}`, eve.id, 'PUT', { collections: ['Onward sharing'] }), ctx('alice.wav'))).status, 403);
    assert.equal((await version.POST(request(`/api/files/alice.wav/uploads?collection=${shared.id}`, eve.id, 'POST', audioForm('file')), ctx('alice.wav'))).status, 403);
  });
  await t.test('a version shared alone reveals no parent, siblings, parent notes or attachments', async () => {
    const created = await collection.POST(request('/api/collections', alice.id, 'POST', { name: 'One take', memberIds: [eve.id] }));
    const take = (await created.json()).collection;
    assert.equal((await playlist.PATCH(request('/playlist', alice.id, 'PATCH', { addSongId: 'take.wav' }), ctx(take.id))).status, 200);
    const files = await listed(eve.id, `&collection=${take.id}`);
    assert.equal(files.length, 1); assert.equal(files[0].id, 'take.wav'); assert.equal(files[0].projectId, undefined);
    assert.deepEqual(files[0].uploads, []); assert.equal(files[0].notes, 'Version notes'); assert.equal(files[0].stems, undefined);
    for (const id of ['alice.wav', 'sibling.wav']) assert.equal((await route('audio').GET(request(`/api/files/${id}/audio?collection=${take.id}`, eve.id), ctx(id))).status, 403);
  });
  await t.test('removing archive access preserves deliberate collection grants but blocks browse and onward sharing', async () => {
    assert.equal((await share(alice.id, [])).status, 200);
    assert.deepEqual(await listed(bob.id, '&archive=alice'), []);
    assert.equal((await route('audio').GET(request('/api/files/alice.wav/audio', bob.id), ctx('alice.wav'))).status, 403);
    const response = await route('audio').GET(request(`/api/files/alice.wav/audio?collection=${shared.id}`, bob.id), ctx('alice.wav'));
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-cache'); await response.arrayBuffer();
    assert.equal((await playlist.PATCH(request('/playlist', bob.id, 'PATCH', { addSongId: 'take.wav' }), ctx(shared.id))).status, 403);
    assert.equal((await playlist.PATCH(request('/playlist', bob.id, 'PATCH', { removeSongId: 'alice.wav' }), ctx(shared.id))).status, 200);
    assert.equal((await route('audio').GET(request(`/api/files/alice.wav/audio?collection=${shared.id}`, bob.id), ctx('alice.wav'))).status, 403);
  });
  await t.test('inbox accepts owners as recipients and revocation hides message content', async () => {
    assert.equal((await share(alice.id, ['adam'])).status, 200);
    const response = await inbox.POST(request('/api/inbox', alice.id, 'POST', { recipientUserId: 'adam', songId: 'alice.wav', note: 'Listen to this' }));
    assert.equal(response.status, 201);
    assert.equal((await (await inbox.GET(request('/api/inbox'))).json()).inbox[0].archiveId, alice.id);
    assert.equal((await inbox.POST(request('/api/inbox', alice.id, 'POST', { recipientUserId: bob.id, songId: 'alice.wav' }))).status, 403);
    await share(alice.id, []);
    const message = (await (await inbox.GET(request('/api/inbox'))).json()).inbox[0];
    assert.equal(message.unavailable, true); assert.equal(message.note, ''); assert.equal(message.songName, 'Unavailable song');
  });
  await t.test('cross-archive links require ownership and cannot move recordings between archives', async () => {
    await share(alice.id, ['adam']);
    assert.equal((await route('link').POST(request('/api/files/legacy.wav/link', 'adam', 'POST', { targetProjectId: 'alice.wav' }), ctx('legacy.wav'))).status, 403);
    assert.equal(data().find(r => r.id === 'legacy.wav').projectId, undefined);
    assert.equal((await registry.POST(request('/api/archives', eve.id, 'POST', {}))).status, 201);
    await share('adam', [eve.id], 'adam');
    save([...data(), { id: 'eve.wav', archiveId: eve.id, name: 'Eve song' }]);
    assert.equal((await route('link').POST(request('/api/files/legacy.wav/link', eve.id, 'POST', { targetProjectId: 'eve.wav' }), ctx('legacy.wav'))).status, 400);
    assert.equal(data().find(r => r.id === 'legacy.wav').projectId, undefined);
  });
  await t.test('revocation during version processing prevents the metadata commit and removes staged audio', async t => {
    await share(alice.id, [bob.id]);
    let release, started;
    const entered = new Promise(resolve => { started = resolve; });
    t.mock.method(generator, 'generateServerWaveform', () => { started(); return new Promise(resolve => { release = resolve; }); });
    const before = fs.readdirSync(storage.getUploadsDir()).sort();
    const pending = version.POST(request('/api/files/alice.wav/uploads', bob.id, 'POST', audioForm('file')), ctx('alice.wav'));
    await entered; await share(alice.id, []); release({ waveformPeaks: [[.1]], waveformDuration: 1 });
    assert.equal((await pending).status, 403);
    assert.deepEqual(fs.readdirSync(storage.getUploadsDir()).sort(), before);
  });
  await t.test('replacement accounts cannot inherit retired archive or collection permissions', async () => {
    const charlie = await auth.createUser('Charlie', 'charlie-password');
    auth.deleteUser(charlie.id);
    const replacement = await auth.createUser('Charlie', 'replacement-password');
    assert.notEqual(replacement.id, charlie.id);
    assert.throws(() => auth.deleteUser(alice.id), /Delete the archive before removing its Archive Admin account/);
    const newAlice = await auth.createUser('Alice', 'new-alice-password');
    assert.notEqual(newAlice.id, alice.id);
    assert.deepEqual(await listed(newAlice.id), []);
    assert.equal((await mutate('alice.wav', newAlice.id, { notes: 'Must not change' })).status, 403);
  });
  await t.test('corrupt archive registry fails closed instead of resetting access', async () => {
    fs.writeFileSync(path.join(storage.getStorageRoot(), 'archives.json'), '{');
    assert.equal((await route('audio').GET(request('/api/files/legacy.wav/audio'), ctx('legacy.wav'))).status, 500);
    assert.equal((await mutate('legacy.wav', 'adam', { notes: 'Do not commit' })).status, 500);
    assert.equal(data().find(r => r.id === 'legacy.wav').notes, 'Keep legacy notes');
  });
});
