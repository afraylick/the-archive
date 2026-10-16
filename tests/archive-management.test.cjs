/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const Module = require('node:module'); const ts = require('typescript'); const { test, after } = require('node:test');
const root = path.resolve(__dirname, '..'); const resolve = Module._resolveFilename;
Module._resolveFilename = function (name, parent, ...rest) { return resolve.call(this, name.startsWith('@/') ? path.join(root, name.slice(2)) : name, parent, ...rest); };
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'songie-archive-management-')); const cwd = process.cwd(); process.chdir(scratch);
process.env.NODE_ENV = 'production'; process.env.ARCHIVE_AUTH_SECRET = 'isolated-management-tests'; delete process.env.ARCHIVE_ACCOUNT_CODES;
after(() => { process.chdir(cwd); fs.rmSync(scratch, { recursive: true, force: true }); });
const load = name => require(path.join(root, name)); const { NextRequest } = require('next/server');
const auth = load('lib/auth.ts'); const storage = load('lib/storage.ts');
const archives = load('lib/archives.ts');
const registry = load('app/api/archives/route.ts');
const collectionRoute = load('app/api/collections/route.ts');
const req = (url, user = 'adam', method = 'GET', body) => new NextRequest(`http://test.local${url}`, { method, headers: { cookie: `archive_session=${auth.createSessionToken(user)}` }, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) });
async function setup() {
  process.env.ARCHIVE_STORAGE_DIR = fs.mkdtempSync(path.join(scratch, 'store-')); storage.ensureStorageDirs(); auth.getPublicUsers();
  await auth.setUserPasscode('adam', 'owner-password'); const alice = await auth.createUser('Alice', 'alice-password'); const bob = await auth.createUser('Bob', 'bob-password');
  assert.equal((await registry.POST(req('/api/archives', alice.id, 'POST', {}))).status, 201);
  assert.equal((await registry.POST(req('/api/archives', bob.id, 'POST', {}))).status, 201);
  return { alice, bob };
}
const { archiveCapabilities } = load('lib/archive-capabilities.ts');
const { archiveManagementContext } = load('lib/archive-management.ts');

test('Activity and Manage follow archive ownership independently of site role', async () => {
  const { alice, bob } = await setup();
  const own = { id: alice.id, ownerId: alice.id, canManage: true };
  assert.equal(archiveCapabilities(own, alice).canViewActivity, true);
  assert.equal(archiveCapabilities(own, alice).canOpenManage, true);
  assert.equal(archiveCapabilities(own, bob).canOpenManage, false);
  for (const role of ['owner', 'admin']) {
    const actor = { id: 'other', role, isAdmin: true };
    const permissions = archiveCapabilities(own, actor);
    assert.equal(permissions.canOpenManage, true);
    assert.equal(permissions.canViewActivity, false);
    assert.equal(permissions.canManageSettings, false);
    assert.equal(permissions.canManageAccounts, false);
  }
  const scoped = { ...alice, archiveScopeId: own.id };
  assert.equal(archiveCapabilities(own, scoped).canOpenManage, false);
  const closing = { ...own, deletingAt: new Date().toISOString() };
  assert.equal(archiveCapabilities(closing, alice).canOpenManage, true);
  assert.equal(archiveCapabilities(closing, alice).canViewActivity, false);
  assert.equal(archiveCapabilities(closing, alice).canManageRecordings, false);
});

test('Manage context rejects other archives without silently falling back to the user’s own archive', async () => {
  const { alice, bob } = await setup();
  assert.equal(archiveManagementContext(alice, bob.id), null);
  const registryFile = path.join(storage.getStorageRoot(), 'archives.json');
  const records = archives.readArchives(); records.find(a => a.id === bob.id).memberIds.push(alice.id);
  load('lib/json-storage.ts').writeJsonAtomic(registryFile, records);
  assert.equal(archiveManagementContext(alice, bob.id), null, 'invited browsing does not grant Manage');
  assert.equal(archiveManagementContext(alice, 'missing'), null);
  const self = archiveManagementContext(alice);
  assert.equal(self.archive.id, alice.id); assert.equal(self.capabilities.canManageSettings, true);
  auth.setUserRole('adam', alice.id, 'admin');
  const promoted = auth.getUserById(alice.id);
  const other = archiveManagementContext(promoted, bob.id);
  assert.equal(other.archive.id, bob.id); assert.equal(other.capabilities.canOpenManage, true);
  assert.equal(other.capabilities.canManageRecordings, false); assert.equal(other.capabilities.canViewActivity, false);
  const legacy = archiveManagementContext(promoted, 'adam');
  // No legacy archive invitation was given to this newly created account.
  assert.equal(legacy.archive, null); assert.equal(legacy.capabilities.canManageSettings, false);
});

test('Manage collections are scoped to the chosen archive without changing cross-archive playlist access', async () => {
  const { alice, bob } = await setup(); const collectionLib = load('lib/collections.ts');
  const one = collectionLib.createCollection('Alice collection', alice, 'private', [bob.id]);
  const two = collectionLib.createCollection('Bob collection', bob, 'private', [alice.id]);
  const scoped = await (await collectionRoute.GET(req(`/api/collections?archive=${alice.id}`, alice.id))).json();
  assert.deepEqual(scoped.collections.map(c => c.id), [one.id]);
  const all = await (await collectionRoute.GET(req('/api/collections', alice.id))).json();
  assert.deepEqual(all.collections.map(c => c.id), [one.id, two.id]);
});

test('archive palette defaults, permissions, persistence and atomic validation', async t => {
  const { alice, bob } = await setup();
  const palettes = load('lib/archive-palettes.ts');
  const patch = (actor, changes) => registry.PATCH(req('/api/archives', actor, 'PATCH', { id: alice.id, ...changes }));
  const aliceArchive = () => archives.readArchives().find(archive => archive.id === alice.id);
  await t.test('eight named presets use blue by default, including archives created before palettes', async () => {
    assert.equal(palettes.ARCHIVE_PALETTES.length, 8);
    assert.equal(new Set(palettes.ARCHIVE_PALETTES.map(palette => palette.id)).size, 8);
    assert.equal(aliceArchive().palette, 'blue');
    const file = path.join(storage.getStorageRoot(), 'archives.json');
    const json = load('lib/json-storage.ts');
    json.writeJsonAtomic(file, archives.readArchives().map(archive => { const copy = { ...archive }; delete copy.palette; return copy; }));
    const before = fs.readFileSync(file);
    const listed = await (await registry.GET(req('/api/archives', alice.id))).json();
    assert.equal(listed.archives.find(archive => archive.id === alice.id).palette, 'blue');
    assert.deepEqual(fs.readFileSync(file), before, 'default requires no migration write');
    assert.equal(palettes.getArchivePalette('unknown').id, 'blue');
  });
  await t.test('only this archive’s Archive Admin can change its palette', async () => {
    assert.equal((await patch(alice.id, { memberIds: [bob.id] })).status, 200);
    assert.equal((await patch(bob.id, { palette: 'rose' })).status, 403);
    auth.setUserRole('adam', bob.id, 'admin');
    assert.equal((await patch(bob.id, { palette: 'rose' })).status, 403);
    assert.equal((await patch('adam', { palette: 'rose' })).status, 403);
    const scoped = await auth.createUser('Scoped', 'scoped-password', alice.id, alice.id);
    assert.equal((await patch(scoped.id, { palette: 'rose' })).status, 403);
  });
  await t.test('each preset persists and is returned to invited viewers without affecting other archives', async () => {
    for (const palette of palettes.ARCHIVE_PALETTES) {
      assert.equal((await patch(alice.id, { palette: palette.id })).status, 200);
      assert.equal(aliceArchive().palette, palette.id);
      const invited = await (await registry.GET(req('/api/archives', bob.id))).json();
      assert.equal(invited.archives.find(archive => archive.id === alice.id).palette, palette.id);
      const keys = Object.keys(palettes.archivePaletteStyle(palette.id));
      assert.ok(keys.every(key => key.startsWith('--')));
    }
    assert.equal(archives.readArchives().find(archive => archive.id === bob.id).palette, undefined);
  });
  await t.test('malformed palette values cannot inject CSS or partially save other settings', async () => {
    const before = fs.readFileSync(path.join(storage.getStorageRoot(), 'archives.json'));
    for (const palette of ['invalid', 'red; background:url(https://example.com)', null, {}, 4, ['blue']]) {
      assert.equal((await patch(alice.id, { palette, name: 'Should not persist', memberIds: [] })).status, 400);
      assert.deepEqual(fs.readFileSync(path.join(storage.getStorageRoot(), 'archives.json')), before);
    }
    assert.equal((await patch(alice.id, { palette: 'teal', memberIds: ['missing-user'] })).status, 400);
    assert.deepEqual(fs.readFileSync(path.join(storage.getStorageRoot(), 'archives.json')), before);
    assert.equal((await patch(alice.id, { name: 'Renamed' })).status, 200);
    assert.equal(aliceArchive().palette, 'violet', 'partial updates retain the selected palette');
  });
  await t.test('a mixed collection uses its own archive palette for collection-only viewers', async () => {
    const collectionLib = load('lib/collections.ts');
    const collection = collectionLib.createCollection('Palette mix', alice, 'private', [bob.id]);
    assert.equal((await patch(alice.id, { palette: 'coral', memberIds: [] })).status, 200);
    const listed = await (await collectionRoute.GET(req('/api/collections', bob.id))).json();
    assert.equal(listed.collections.find(item => item.id === collection.id).palette, 'coral');
    assert.equal(archives.canAccessArchive(aliceArchive(), auth.getUserById(bob.id)), false);
  });
});

test('complete palettes tint surfaces and text while retaining dark-theme contrast and lightness', () => {
  const { ARCHIVE_PALETTES, archivePaletteStyle } = load('lib/archive-palettes.ts');
  const channels = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
  const lightness = hex => { const values = channels(hex); return (Math.max(...values) + Math.min(...values)) / 2; };
  const luminance = hex => channels(hex).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
  const base = archivePaletteStyle('blue');
  const tokens = ['--background', '--foreground', '--muted-foreground', '--border', '--archive-pane', '--archive-field', '--archive-menu'];
  for (const palette of ARCHIVE_PALETTES) {
    const style = archivePaletteStyle(palette.id);
    for (const token of tokens) {
      assert.match(style[token], /^#[0-9a-f]{6}$/i);
      assert.ok(Math.abs(lightness(style[token]) - lightness(base[token])) < .005, `${palette.id} retains ${token} lightness`);
      if (palette.id !== 'blue') assert.notEqual(style[token], base[token], `${token} follows ${palette.id}`);
    }
    assert.ok(contrast(style['--foreground'], style['--archive-pane']) >= 10, `${palette.id}: main text contrast`);
    assert.ok(contrast(style['--muted-foreground'], style['--archive-pane']) >= 5, `${palette.id}: secondary text contrast`);
  }
});
