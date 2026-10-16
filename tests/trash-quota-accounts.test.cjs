/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const Module = require('node:module'); const ts = require('typescript'); const { test, after } = require('node:test');
const root = path.resolve(__dirname, '..'); const resolve = Module._resolveFilename;
Module._resolveFilename = function (name, parent, ...rest) { return resolve.call(this, name.startsWith('@/') ? path.join(root, name.slice(2)) : name, parent, ...rest); };
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'songie-trash-quota-')); const cwd = process.cwd(); process.chdir(scratch);
process.env.NODE_ENV = 'production'; process.env.ARCHIVE_AUTH_SECRET = 'isolated-trash-quota-tests'; delete process.env.ARCHIVE_ACCOUNT_CODES;
after(() => { process.chdir(cwd); fs.rmSync(scratch, { recursive: true, force: true }); });
const load = name => require(path.join(root, name)); const { NextRequest } = require('next/server');
const auth = load('lib/auth.ts'); const storage = load('lib/storage.ts'); const json = load('lib/json-storage.ts');
const archives = load('lib/archives.ts'); const quotas = load('lib/upload-quota.ts'); const trash = load('lib/trash.ts');
const registry = load('app/api/archives/route.ts'); const users = load('app/api/archives/[id]/users/route.ts');
const files = load('app/api/files/route.ts'); const recording = load('app/api/files/[id]/route.ts');
const audio = load('app/api/files/[id]/audio/route.ts'); const collections = load('app/api/collections/route.ts'); const playlist = load('app/api/collections/[id]/route.ts');
const upload = load('app/api/upload/route.ts'); const stems = load('app/api/files/[id]/stems/route.ts'); const generator = load('lib/server-waveform.ts');
const ctx = id => ({ params: Promise.resolve({ id }) });
const req = (url, user = 'adam', method = 'GET', body) => new NextRequest(`http://test.local${url}`, { method, headers: { cookie: `archive_session=${auth.createSessionToken(user)}` }, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) });
const save = records => json.writeJsonAtomic(storage.getDataFilePath(), records); const read = () => json.readArchive();
const form = (field, name = 'sample.wav', bytes = 44) => { const body = new FormData(); const data = Buffer.alloc(bytes); if (name.endsWith('.wav')) { data.write('RIFF'); data.write('WAVE', 8); } body.append(field, new File([data], name)); return body; };
async function setup() {
  process.env.ARCHIVE_STORAGE_DIR = fs.mkdtempSync(path.join(scratch, 'store-')); storage.ensureStorageDirs(); auth.getPublicUsers();
  await auth.setUserPasscode('adam', 'owner-password'); const alice = await auth.createUser('Alice', 'alice-password'); const bob = await auth.createUser('Bob', 'bob-password');
  assert.equal((await registry.POST(req('/api/archives', alice.id, 'POST', {}))).status, 201);
  assert.equal((await registry.POST(req('/api/archives', bob.id, 'POST', {}))).status, 201);
  return { alice, bob };
}
function media(id, bytes = 100) { fs.writeFileSync(storage.getUploadPath(id), 'audio'); fs.truncateSync(storage.getUploadPath(id), bytes); }

test('recoverable trash preserves media and detaches collection access', async t => {
  const { alice, bob } = await setup();
  const common = { archiveId: alice.id, uploadedBy: alice.id, name: 'Song', notes: 'Keep notes', comments: [{ userId: bob.id, text: 'Keep comment' }], ratings: { [alice.id]: 4 }, collections: [] };
  save([{ ...common, id: 'main.wav', defaultVersionId: 'new.wav', stems: { id: 'parts.zip' } }, { ...common, id: 'old.wav', projectId: 'main.wav' }, { ...common, id: 'new.wav', projectId: 'main.wav' }]);
  for (const id of ['main.wav', 'old.wav', 'new.wav']) media(id); fs.writeFileSync(storage.getStemPath('parts.zip'), 'stems');
  const created = await collections.POST(req('/api/collections', alice.id, 'POST', { name: 'Shared', memberIds: [bob.id] })); const collection = (await created.json()).collection;
  for (const id of ['main.wav', 'new.wav']) assert.equal((await playlist.PATCH(req('/playlist', alice.id, 'PATCH', { addSongId: id }), ctx(collection.id))).status, 200);
  await t.test('trashing a version resets the parent default but retains bytes', async () => {
    assert.equal((await recording.DELETE(req('/api/files/old.wav', alice.id, 'DELETE'), ctx('old.wav'))).status, 200);
    assert.equal(read().find(r => r.id === 'old.wav').trashedBy, alice.id);
    assert.equal(fs.existsSync(storage.getUploadPath('old.wav')), true);
    assert.equal((await recording.PATCH(req('/api/files/main.wav', alice.id, 'PATCH', { operation: 'metadata', changes: { defaultVersionId: 'old.wav' } }), ctx('main.wav'))).status, 400);
  });
  await t.test('deleting a song atomically hides it and its active versions from every access path', async () => {
    const usage = quotas.userStorageUsage(alice.id, true).usedBytes;
    const response = await recording.DELETE(req('/api/files/main.wav', alice.id, 'DELETE'), ctx('main.wav'));
    assert.equal(response.status, 200);
    assert.equal(read().filter(record => !record.trashedAt).length, 0);
    assert.ok(read().every(record => record.collections.length === 0));
    const listed = await (await files.GET(req('/api/files?view=metadata&archive=alice', alice.id))).json(); assert.deepEqual(listed, []);
    assert.deepEqual((await (await files.GET(req(`/api/files?view=metadata&collection=${collection.id}`, bob.id))).json()), []);
    for (const id of ['main.wav', 'new.wav']) assert.equal((await audio.GET(req(`/api/files/${id}/audio?collection=${collection.id}`, bob.id), ctx(id))).status, 404);
    assert.deepEqual((await (await playlist.GET(req('/playlist', bob.id), ctx(collection.id))).json()).collection.songIds, []);
    assert.deepEqual(load('lib/collections.ts').readCollections()[0].trackOrder, []);
    assert.equal((await playlist.PATCH(req('/playlist', alice.id, 'PATCH', { addSongId: 'main.wav' }), ctx(collection.id))).status, 400);
    assert.equal(quotas.userStorageUsage(alice.id, true).usedBytes, usage);
    assert.equal(quotas.userStorageUsage(alice.id, true).trashBytes, usage);
  });
  await t.test('missing media does not silently remove a recording from trash', () => {
    fs.renameSync(storage.getUploadPath('old.wav'), storage.getUploadPath('old-temporary.wav'));
    assert.throws(() => trash.restoreRecording('old.wav', alice), /parent song/);
    fs.renameSync(storage.getUploadPath('old-temporary.wav'), storage.getUploadPath('old.wav'));
    fs.renameSync(storage.getUploadPath('main.wav'), storage.getUploadPath('main-temporary.wav'));
    assert.throws(() => trash.restoreRecording('main.wav', alice), /media is missing/);
    assert.equal(Boolean(read().find(r => r.id === 'main.wav').trashedAt), true);
    fs.renameSync(storage.getUploadPath('main-temporary.wav'), storage.getUploadPath('main.wav'));
  });
  await t.test('only authorized editors can view or restore trash, and child restoration waits for the parent', async () => {
    assert.equal(trash.listTrash(bob, alice.id).length, 0);
    assert.throws(() => trash.restoreRecording('main.wav', bob), /not available/);
    assert.throws(() => trash.restoreRecording('old.wav', alice), /parent song/);
    const result = trash.restoreRecording('main.wav', alice); assert.deepEqual(new Set(result.ids), new Set(['main.wav', 'new.wav']));
    assert.equal(Boolean(read().find(record => record.id === 'old.wav').trashedAt), true, 'a previously trashed version stays trashed');
    const restored = read().find(record => record.id === 'main.wav'); assert.equal(restored.notes, 'Keep notes'); assert.equal(restored.comments[0].text, 'Keep comment'); assert.equal(restored.ratings[alice.id], 4); assert.equal(restored.defaultVersionId, 'new.wav'); assert.deepEqual(restored.collections, []);
    assert.deepEqual((await (await playlist.GET(req('/playlist', bob.id), ctx(collection.id))).json()).collection.songIds, []);
    assert.equal((await playlist.PATCH(req('/playlist', alice.id, 'PATCH', { addSongId: 'main.wav' }), ctx(collection.id))).status, 200);
    assert.deepEqual((await (await playlist.GET(req('/playlist', bob.id), ctx(collection.id))).json()).collection.songIds, ['main.wav']);
  });
  await t.test('failed trash/restore/purge commits leave the last state and media intact', async t => {
    const before = fs.readFileSync(storage.getDataFilePath());
    t.mock.method(json, 'writeJsonAtomic', () => { throw new Error('Disk unavailable'); });
    assert.throws(() => trash.trashRecording('main.wav', alice), /Disk unavailable/);
    assert.throws(() => trash.restoreRecording('old.wav', alice), /Disk unavailable/);
    assert.throws(() => trash.purgeRecording('old.wav', alice), /Disk unavailable/);
    assert.deepEqual(fs.readFileSync(storage.getDataFilePath()), before);
    assert.equal(fs.existsSync(storage.getUploadPath('old.wav')), true);
  });
  await t.test('permanent deletion is limited to trash and releases source/attachment quota', async () => {
    assert.throws(() => trash.purgeRecording('main.wav', alice), /not found in trash/);
    trash.trashRecording('main.wav', alice);
    assert.throws(() => trash.purgeRecording('main.wav', bob), /not available/);
    trash.purgeRecording('main.wav', alice);
    assert.deepEqual(read(), []); assert.equal(quotas.userStorageUsage(alice.id, true).usedBytes, 0);
    for (const id of ['main.wav', 'old.wav', 'new.wav']) assert.equal(fs.existsSync(storage.getUploadPath(id)), false);
    assert.equal(fs.existsSync(storage.getStemPath('parts.zip')), false);
  });
});

test('5 GB quota spans originals, versions, stems, trash and concurrent streams', async t => {
  const { alice, bob } = await setup(); const limit = quotas.USER_UPLOAD_QUOTA_BYTES;
  await t.test('legacy ownership and explicit uploader attribution are counted separately', () => {
    save([{ id: 'legacy.wav', name: 'Legacy' }, { id: 'alice.wav', archiveId: alice.id, name: 'Alice', uploadedBy: alice.id, stems: { id: 'parts.zip', uploadedBy: bob.id } }, { id: 'version.wav', archiveId: alice.id, projectId: 'alice.wav', uploadedBy: bob.id }]);
    media('legacy.wav', 10); media('alice.wav', 20); media('version.wav', 30); fs.writeFileSync(storage.getStemPath('parts.zip'), Buffer.alloc(40));
    assert.equal(quotas.userStorageUsage('adam', true).usedBytes, 10); assert.equal(quotas.userStorageUsage(alice.id, true).usedBytes, 20); assert.equal(quotas.userStorageUsage(bob.id, true).usedBytes, 70);
    trash.trashRecording('alice.wav', alice); assert.equal(quotas.userStorageUsage(alice.id, true).trashBytes, 20); assert.equal(quotas.userStorageUsage(bob.id, true).trashBytes, 70);
  });
  await t.test('two concurrent requests cannot reserve the same remaining space; failures clean staged files', async t => {
    save([{ id: 'full.wav', archiveId: alice.id, uploadedBy: alice.id }]); media('full.wav', limit - 60);
    let release, start; const entered = new Promise(resolve => { start = resolve; });
    t.mock.method(generator, 'generateServerWaveform', () => { start(); return new Promise(resolve => { release = resolve; }); });
    t.mock.method(console, 'error', () => {});
    const first = upload.POST(req('/api/upload?archive=alice', alice.id, 'POST', form('files'))); await entered;
    assert.equal(quotas.uploadStorageSummary(alice.id).reservedBytes, 44);
    const second = await upload.POST(req('/api/upload?archive=alice', alice.id, 'POST', form('files'))); assert.equal(second.status, 413);
    assert.equal(quotas.uploadStorageSummary(alice.id).reservedBytes, 44);
    release({ waveformPeaks: [[.1]], waveformDuration: 1 }); assert.equal((await first).status, 200);
    const usage = quotas.uploadStorageSummary(alice.id); assert.equal(usage.usedBytes, limit - 16); assert.equal(usage.reservedBytes, 0);
    assert.equal(fs.readdirSync(storage.getStorageRoot()).some(name => name.startsWith('.incoming-')), false);
    assert.equal(read().length, 2);
  });
  await t.test('versions and stems cannot bypass quota; a same-size replacement receives credit once', async t => {
    save([{ id: 'full.wav', name: 'Full', archiveId: alice.id, uploadedBy: alice.id, stems: { id: 'existing.zip', uploadedBy: alice.id } }]); media('full.wav', limit - 100); fs.writeFileSync(storage.getStemPath('existing.zip'), Buffer.alloc(100));
    t.mock.method(console, 'error', () => {});
    const denied = await load('app/api/files/[id]/uploads/route.ts').POST(req('/api/files/full.wav/uploads', alice.id, 'POST', form('file')), ctx('full.wav')); assert.equal(denied.status, 413);
    assert.equal((await stems.POST(req('/api/files/full.wav/stems', alice.id, 'POST', form('file', 'larger.zip', 101)), ctx('full.wav'))).status, 413);
    assert.equal((await stems.POST(req('/api/files/full.wav/stems', alice.id, 'POST', form('file', 'replacement.zip', 90)), ctx('full.wav'))).status, 200);
    assert.equal(quotas.uploadStorageSummary(alice.id).usedBytes, limit - 10); assert.equal(quotas.uploadStorageSummary(alice.id).reservedBytes, 0);
    assert.equal(fs.existsSync(storage.getStemPath('existing.zip')), false);
    assert.equal(read()[0].stems.uploadedBy, alice.id);
    const first = quotas.reserveUploadQuota(alice.id, quotas.stemReplacementCredit('full.wav', alice.id));
    assert.throws(() => quotas.reserveUploadQuota(alice.id, quotas.stemReplacementCredit('full.wav', alice.id)), /already being replaced/); first.release();
  });
  await t.test('trash keeps counting and purge frees capacity without changing other users usage', () => {
    const before = quotas.uploadStorageSummary(alice.id).usedBytes;
    trash.trashRecording('full.wav', alice); assert.equal(quotas.uploadStorageSummary(alice.id).usedBytes, before);
    const blocked = quotas.reserveUploadQuota(alice.id); assert.throws(() => blocked.addBytes(11), /5 GB/); blocked.release();
    trash.purgeRecording('full.wav', alice); assert.equal(quotas.uploadStorageSummary(alice.id).usedBytes, 0);
    const next = quotas.reserveUploadQuota(alice.id); next.addBytes(1000); next.release();
  });
});

test('archive-only accounts have owner-set limits and cannot escape their archive', async t => {
  const { alice, bob } = await setup(); const context = ctx(alice.id); let guest;
  const limits = value => registry.PATCH(req('/api/archives', 'adam', 'PATCH', { id: alice.id, accountLimit: value }));
  const create = (name, password) => users.POST(req(`/api/archives/alice/users`, alice.id, 'POST', { name, passcode: password }), context);
  await t.test('the site Owner configures 0–100 accounts per archive; archive owners cannot raise their own limit', async () => {
    assert.equal((await (await users.GET(req('/accounts', alice.id), context)).json()).limit, 10);
    assert.equal((await registry.GET(req('/api/archives?view=limits', alice.id))).status, 403);
    assert.equal((await registry.PATCH(req('/api/archives', alice.id, 'PATCH', { id: alice.id, accountLimit: 99 }))).status, 403);
    for (const value of [-1, 101, 1.5, '10']) assert.equal((await limits(value)).status, 400);
    assert.equal((await limits(1)).status, 200);
  });
  await t.test('parallel creation respects the cap and assigns only scoped Member permissions', async () => {
    const responses = await Promise.all([create('Listener One', 'listener-one-password'), create('Listener Two', 'listener-two-password')]);
    assert.deepEqual(responses.map(r => r.status).sort(), [201, 400]);
    guest = auth.getPublicUsers().find(user => user.archiveScopeId === alice.id);
    assert.equal(guest.role, 'member'); assert.equal(guest.isAdmin, false);
    assert.equal(archives.readArchives().find(a => a.id === alice.id).memberIds.includes(guest.id), true);
    assert.equal((await users.POST(req('/accounts', bob.id, 'POST', { name: 'Intruder', passcode: 'intruder-password' }), context)).status, 403);
    assert.equal((await users.POST(req('/accounts', alice.id, 'POST', { name: 'Admin', passcode: 'admin-password', role: 'admin' }), context)).status, 400);
    assert.throws(() => auth.setUserRole('adam', guest.id, 'admin'), /cannot become site administrators/);
  });
  await t.test('scoped sessions expose only their archive and cannot create archives or join another archive', async () => {
    const visible = (await (await registry.GET(req('/api/archives', guest.id))).json()).archives; assert.deepEqual(visible.map(a => a.id), [alice.id]);
    assert.equal((await registry.POST(req('/api/archives', guest.id, 'POST', {}))).status, 403);
    assert.equal((await registry.PATCH(req('/api/archives', bob.id, 'PATCH', { id: bob.id, memberIds: [guest.id] }))).status, 400);
    assert.equal((await users.POST(req('/accounts', guest.id, 'POST', { name: 'Subguest', passcode: 'subguest-password' }), context)).status, 403);
    save([{ id: 'a.wav', archiveId: alice.id, name: 'Alice song' }, { id: 'b.wav', archiveId: bob.id, name: 'Bob song' }]); media('a.wav'); media('b.wav');
    assert.deepEqual((await (await files.GET(req('/api/files?scope=accessible&view=metadata', guest.id))).json()).map(r => r.id), ['a.wav']);
    assert.equal((await audio.GET(req('/api/files/b.wav/audio', guest.id), ctx('b.wav'))).status, 403);
    const session = await (await load('app/api/session/route.ts').GET(req('/api/session', guest.id))).json();
    assert.equal(session.users.some(user => user.id === bob.id), false); assert.equal(session.users.some(user => user.id === alice.id), true);
    assert.equal(auth.getUsersForViewer(bob).some(user => user.id === guest.id), false);
  });
  await t.test('public collections outside the assigned archive stay unavailable even with a forged invitation', async () => {
    const publicCollection = (await (await collections.POST(req('/api/collections', bob.id, 'POST', { name: 'Other public', visibility: 'public' }))).json()).collection;
    const ownCollection = (await (await collections.POST(req('/api/collections', alice.id, 'POST', { name: 'Our public', visibility: 'public' }))).json()).collection;
    assert.equal((await playlist.GET(req('/playlist', guest.id), ctx(publicCollection.id))).status, 404);
    assert.equal((await playlist.GET(req('/playlist', guest.id), ctx(ownCollection.id))).status, 200);
    assert.equal((await playlist.PATCH(req('/playlist', bob.id, 'PATCH', { memberIds: [guest.id] }), ctx(publicCollection.id))).status, 400);
    const visible = (await (await collections.GET(req('/api/collections', guest.id))).json()).collections;
    assert.deepEqual(visible.map(c => c.name), ['Our public']);
  });
  await t.test('password management stays within the owning archive, revokes sessions, and cannot take over global accounts', async () => {
    const token = auth.createSessionToken(guest.id);
    assert.equal((await users.PATCH(req('/accounts', bob.id, 'PATCH', { userId: guest.id, passcode: 'new-guest-password' }), context)).status, 403);
    assert.equal((await users.PATCH(req('/accounts', alice.id, 'PATCH', { userId: bob.id, passcode: 'takeover-password' }), context)).status, 403);
    assert.equal((await users.PATCH(req('/accounts', alice.id, 'PATCH', { userId: guest.id, passcode: 'new-guest-password' }), context)).status, 200);
    assert.equal(auth.getUserFromSessionToken(token), null); assert.equal(await auth.verifyPasscode(guest.id, 'new-guest-password'), true);
  });
  await t.test('owners cannot leave; removing an archive-only account frees a slot and revokes its credentials', async () => {
    const ownerToken = auth.createSessionToken(alice.id);
    assert.throws(() => auth.deleteUser(alice.id), /Delete the archive before removing its Archive Admin account/); assert.equal(auth.getUserFromSessionToken(ownerToken).id, alice.id);
    assert.equal((await users.DELETE(req('/accounts', alice.id, 'DELETE', { userId: bob.id }), context)).status, 403);
    assert.equal((await users.DELETE(req('/accounts', alice.id, 'DELETE', { userId: guest.id }), context)).status, 200);
    assert.equal(auth.getUserById(guest.id), undefined); assert.equal(await auth.verifyPasscode(guest.id, 'new-guest-password'), false);
    assert.equal((await create('Replacement', 'replacement-password')).status, 201);
    assert.equal((await limits(0)).status, 200); assert.equal((await create('Blocked', 'blocked-password')).status, 400);
    assert.equal(auth.getPublicUsers().filter(u => u.archiveScopeId === alice.id).length, 1, 'lowering a limit leaves existing accounts intact');
    await limits(2);
    const pending = create('Pending listener', 'pending-listener-password');
    await limits(1);
    assert.equal((await pending).status, 400, 'an account limit lowered during hashing is rechecked before account commit');
    assert.equal(auth.getPublicUsers().filter(u => u.archiveScopeId === alice.id).length, 1);
  });
});
