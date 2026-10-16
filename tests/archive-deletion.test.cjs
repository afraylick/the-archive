/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const Module = require('node:module'); const ts = require('typescript'); const { test, after } = require('node:test');
const root = path.resolve(__dirname, '..'); const resolve = Module._resolveFilename;
Module._resolveFilename = function (name, parent, ...rest) { return resolve.call(this, name.startsWith('@/') ? path.join(root, name.slice(2)) : name, parent, ...rest); };
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'songie-archive-deletion-')); const cwd = process.cwd(); process.chdir(scratch);
process.env.NODE_ENV = 'production'; process.env.ARCHIVE_AUTH_SECRET = 'isolated-trash-quota-tests'; delete process.env.ARCHIVE_ACCOUNT_CODES;
after(() => { process.chdir(cwd); fs.rmSync(scratch, { recursive: true, force: true }); });
const load = name => require(path.join(root, name)); const { NextRequest } = require('next/server');
const auth = load('lib/auth.ts'); const storage = load('lib/storage.ts'); const json = load('lib/json-storage.ts');
const archives = load('lib/archives.ts');
const deletion = load('app/api/archives/[id]/route.ts'); const registry = load('app/api/archives/route.ts');
const audio = load('app/api/files/[id]/audio/route.ts');
const upload = load('app/api/upload/route.ts'); const generator = load('lib/server-waveform.ts');
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

test('archive roles, deletion boundaries, and cleanup', async t => {
  const { alice, bob } = await setup();
  const admin = await auth.createUser('Site admin', 'admin-password'); auth.setUserRole('adam', admin.id, 'admin');
  const guest = await auth.createUser('Guest', 'guest-password', alice.id, alice.id);
  const guestToken = auth.createSessionToken(guest.id);
  const collectionLib = load('lib/collections.ts');
  const own = collectionLib.createCollection('Alice list', alice);
  const mixed = collectionLib.createCollection('Mixed list', bob, 'private', [alice.id]);
  const sharedKeys = [own.id, mixed.id];
  save([{ id: 'main.wav', archiveId: alice.id, collections: sharedKeys, stems: { id: 'parts.zip' } },
    { id: 'take.wav', projectId: 'main.wav', archiveId: alice.id, collections: sharedKeys, uploadedBy: guest.id },
    { id: 'trash.wav', archiveId: alice.id, trashedAt: new Date().toISOString(), collections: [] },
    { id: 'bob.wav', archiveId: bob.id, notes: 'Keep me', collections: sharedKeys },
    { id: 'legacy.wav', collections: [] }]);
  for (const id of ['main.wav', 'take.wav', 'trash.wav', 'bob.wav', 'legacy.wav']) { media(id); fs.writeFileSync(path.join(storage.getTranscodedDir(), `${id}.mp3`), 'cache'); }
  fs.writeFileSync(storage.getStemPath('parts.zip'), 'stems');
  const lists = collectionLib.readCollections().map(list => ({ ...list, trackOrder: ['main.wav', 'take.wav', 'bob.wav'] })); collectionLib.writeCollections(lists);
  const inboxLib = load('lib/inbox.ts');
  inboxLib.writeInboxMessages([{ id: 'gone', songId: 'main.wav', senderUserId: alice.id, recipientUserId: bob.id }, { id: 'keep', songId: 'bob.wav', senderUserId: bob.id, recipientUserId: 'adam' }]);
  const name = archives.readArchives().find(a => a.id === alice.id).name;
  const remove = (actor, confirmation = name, id = alice.id) => deletion.DELETE(req('/api/archives/'+id, actor, 'DELETE', { confirmation }), ctx(id));
  await t.test('Owner is site-wide; Archive Admin is independent of site roles', async () => {
    const roles = load('lib/roles.ts');
    assert.equal(roles.roleLabel('owner'), 'Owner'); assert.equal(roles.roleLabel('admin'), 'Site Admin');
    const accounts = await (await load('app/api/users/route.ts').GET(req('/api/users'))).json();
    assert.equal(accounts.users.find(user => user.id === alice.id).role, 'member');
    assert.equal(accounts.users.find(user => user.id === alice.id).isArchiveAdmin, true);
    assert.equal(archives.canDeleteArchive(archives.readArchives().find(a => a.id === alice.id), auth.getUserById('adam')), true);
    assert.equal(archives.canAccessArchive(archives.readArchives().find(a => a.id === alice.id), auth.getUserById('adam')), false);
  });
  await t.test('invited members, scoped accounts, and Site Admins cannot delete another archive', async () => {
    for (const actor of [bob.id, guest.id, admin.id]) assert.equal((await remove(actor)).status, 403);
    assert.equal((await deletion.DELETE(new NextRequest('http://test.local/api/archives/alice', { method: 'DELETE', body: JSON.stringify({ confirmation: name }) }), ctx(alice.id))).status, 401);
    assert.equal((await remove(alice.id, 'DELETE')).status, 400);
    assert.equal(read().length, 5); assert.ok(fs.existsSync(storage.getUploadPath('main.wav')));
  });
  await t.test('site Owner can delete another archive without browsing permission', async () => {
    assert.equal((await remove('adam')).status, 200);
    assert.equal(archives.readArchives().some(a => a.id === alice.id), false);
    assert.deepEqual(read().map(r => r.id), ['bob.wav', 'legacy.wav']);
    assert.equal(read()[0].notes, 'Keep me'); assert.deepEqual(read()[0].collections, [mixed.id]);
    assert.deepEqual(collectionLib.readCollections().map(list => list.id), [mixed.id]);
    assert.deepEqual(collectionLib.readCollections()[0].trackOrder, ['bob.wav']);
    assert.deepEqual(inboxLib.readInboxMessages().map(message => message.id), ['keep']);
    assert.equal(auth.getUserById(guest.id), undefined); assert.equal(auth.getUserFromSessionToken(guestToken), null);
    assert.equal(auth.getUserById(alice.id).role, 'member'); assert.equal(auth.getUserById('adam').role, 'owner');
    for (const id of ['main.wav', 'take.wav', 'trash.wav']) { assert.equal(fs.existsSync(storage.getUploadPath(id)), false); assert.equal(fs.existsSync(path.join(storage.getTranscodedDir(), `${id}.mp3`)), false); }
    assert.equal(fs.existsSync(storage.getStemPath('parts.zip')), false);
    for (const id of ['bob.wav', 'legacy.wav']) assert.ok(fs.existsSync(storage.getUploadPath(id)));
    assert.equal((await audio.GET(req(`/audio?collection=${mixed.id}`, bob.id), ctx('main.wav'))).status, 404);
  });
  await t.test('Archive Admin can delete their own replacement archive and recreate privately', async () => {
    const response = await registry.POST(req('/api/archives', alice.id, 'POST', {})); assert.equal(response.status, 201);
    const replacement = (await response.json()).archive; assert.notEqual(replacement.id, alice.id); assert.deepEqual(replacement.memberIds, []);
    assert.equal((await remove(alice.id, replacement.name, replacement.id)).status, 200);
    assert.ok(auth.getUserById(alice.id));
  });
  await t.test('deleting the site Owner’s archive preserves the protected Owner account', async () => {
    const ownerArchive = archives.readArchives().find(a => a.id === 'adam');
    assert.equal((await remove('adam', ownerArchive.name, ownerArchive.id)).status, 200);
    assert.equal(auth.getUserById('adam').role, 'owner'); assert.ok(auth.getUserFromSessionToken(auth.createSessionToken('adam')));
    assert.throws(() => auth.deleteUser('adam'), /Owner accounts/);
    assert.equal(archives.readArchives().some(a => a.id === 'adam'), false);
    assert.deepEqual(read().map(r => r.id), ['bob.wav']);
  });
});

test('interrupted archive deletion fails closed and is safely retryable', async t => {
  t.mock.method(console, 'error', () => {});
  const { alice, bob } = await setup();
  const guest = await auth.createUser('Guest', 'guest-password', alice.id, alice.id); const guestToken = auth.createSessionToken(guest.id);
  const collectionLib = load('lib/collections.ts'); const list = collectionLib.createCollection('Mixed', bob, 'private', [alice.id]);
  save([{ id: 'main.wav', archiveId: alice.id, collections: [list.id] }, { id: 'bob.wav', archiveId: bob.id, collections: [list.id] }]); media('main.wav'); media('bob.wav');
  const target = archives.readArchives().find(a => a.id === alice.id);
  const remove = () => deletion.DELETE(req('/archive', alice.id, 'DELETE', { confirmation: target.name }), ctx(alice.id));
  const write = json.writeJsonAtomic;
  const mock = t.mock.method(json, 'writeJsonAtomic', (file, value) => { if (file === storage.getDataFilePath()) throw new Error('Simulated metadata disk failure'); return write(file, value); });
  assert.equal((await remove()).status, 500); mock.mock.restore();
  assert.ok(archives.readArchives().find(a => a.id === alice.id).deletingAt);
  assert.equal(archives.selectedArchive(alice, alice.id), undefined);
  assert.deepEqual(collectionLib.collectionTrackIds(list), ['bob.wav']);
  assert.equal((await audio.GET(req(`/audio?collection=${list.id}`, bob.id), ctx('main.wav'))).status, 403);
  assert.equal(auth.getUserFromSessionToken(guestToken), null);
  assert.equal((await registry.PATCH(req('/api/archives', alice.id, 'PATCH', { id: alice.id, name: 'Reopen' }))).status, 409);
  assert.equal((await registry.POST(req('/api/archives', alice.id, 'POST', {}))).status, 409);
  assert.equal((await (await registry.GET(req('/api/archives', alice.id))).json()).pendingDeletions[0].id, alice.id);
  // Failure after metadata removal must retain the media manifest for the next attempt.
  const removeFile = fs.rmSync;
  const mediaFailure = t.mock.method(fs, 'rmSync', (file, options) => { if (file === storage.getUploadPath('main.wav')) throw new Error('Simulated media disk failure'); return removeFile(file, options); });
  assert.equal((await remove()).status, 500); mediaFailure.mock.restore();
  assert.deepEqual(read().map(r => r.id), ['bob.wav']); assert.ok(fs.existsSync(storage.getUploadPath('main.wav')));
  assert.equal((await remove()).status, 200);
  assert.equal(fs.existsSync(storage.getUploadPath('main.wav')), false); assert.ok(fs.existsSync(storage.getUploadPath('bob.wav')));
  assert.equal(archives.readArchives().some(a => a.id === alice.id), false);
  assert.equal((await remove()).status, 404);
});

test('an upload started before archive deletion cannot land in a replacement archive', async t => {
  t.mock.method(console, 'error', () => {});
  const { alice } = await setup();
  let resume; let reached; const paused = new Promise(resolve => { reached = resolve; });
  t.mock.method(generator, 'generateServerWaveform', async () => { reached(); await new Promise(resolve => { resume = resolve; }); return { waveformPeaks: [[.1]], waveformDuration: 1 }; });
  const pending = upload.POST(req(`/api/upload?archive=${alice.id}`, alice.id, 'POST', form('files')));
  await paused;
  const target = archives.readArchives().find(a => a.id === alice.id);
  assert.equal((await deletion.DELETE(req('/archive', alice.id, 'DELETE', { confirmation: target.name }), ctx(alice.id))).status, 200);
  assert.equal((await registry.POST(req('/api/archives', alice.id, 'POST', {}))).status, 201);
  resume(); assert.notEqual((await pending).status, 200);
  assert.deepEqual(read(), []); assert.deepEqual(fs.readdirSync(storage.getUploadsDir()), []);
});
