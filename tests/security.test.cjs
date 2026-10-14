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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'songie-security-test-'));
const originalCwd = process.cwd();
process.chdir(scratch); // Isolate the legacy ./data paths too.
process.env.NODE_ENV = 'production';
process.env.ARCHIVE_AUTH_SECRET = 'isolated-storage-tests-only';
delete process.env.ARCHIVE_ACCOUNT_CODES;
after(() => { process.chdir(originalCwd); fs.rmSync(scratch, { recursive: true, force: true }); });
const load = name => require(path.join(root, name));
const { NextRequest } = require('next/server');
const json = load('lib/json-storage.ts');
const auth = load('lib/auth.ts');
const crypto = require('node:crypto');
const limiter = load('lib/login-rate-limit.ts');
const { TaskLimiter } = load('lib/task-limiter.ts');
const audio = load('lib/audio-processing.ts');
const waveform = load('lib/server-waveform.ts');
const session = load('app/api/session/route.ts');
const fresh = () => {
  process.env.ARCHIVE_STORAGE_DIR = fs.mkdtempSync(path.join(scratch, 'archive-'));
  delete process.env.ARCHIVE_ACCOUNT_CODES;
  delete process.env.ARCHIVE_TRUSTED_IP_HEADER;
  auth.getPublicUsers();
};
const file = name => path.join(process.env.ARCHIVE_STORAGE_DIR, name);
const req = headers => new NextRequest('http://test.local/api/session', { headers });

test('credential migration and revocation', async t => {
  await t.test('no public default; explicit setup stores a salted password', async () => {
    fresh();
    assert.equal(await auth.getUserByPasscode('admin'), undefined);
    process.env.ARCHIVE_ACCOUNT_CODES = JSON.stringify({ adam: 'explicit-initial-password' });
    assert.equal((await auth.getUserByPasscode('explicit-initial-password')).id, 'adam');
    assert.match(JSON.parse(fs.readFileSync(file('users.json'))).adam, /^scrypt-v1\$/);
    delete process.env.ARCHIVE_ACCOUNT_CODES;
    assert.equal(await auth.verifyPasscode('adam', 'explicit-initial-password'), true);
  });
  await t.test('legacy hashes migrate without changing archive bytes or other credentials', async () => {
    fresh();
    const legacy = crypto.createHmac('sha256', process.env.ARCHIVE_AUTH_SECRET).update('existing-password').digest('base64url');
    json.writeJsonAtomic(file('users.json'), { adam: legacy, other: legacy });
    fs.writeFileSync(file('data.json'), '[{"id":"keep","comments":["keep"]}]');
    const before = fs.readFileSync(file('data.json'));
    assert.equal((await auth.getUserByPasscode('existing-password')).id, 'adam');
    const hashes = JSON.parse(fs.readFileSync(file('users.json')));
    assert.match(hashes.adam, /^scrypt-v1\$/);
    assert.equal(hashes.other, legacy);
    assert.deepEqual(fs.readFileSync(file('data.json')), before);
  });
  await t.test('corrupt, missing and malformed credential files fail closed', async () => {
    for (const broken of ['{', 'null', '{}']) {
      fresh();
      await auth.setUserPasscode('adam', 'existing-password');
      const token = auth.createSessionToken('adam');
      process.env.ARCHIVE_ACCOUNT_CODES = '{"adam":"admin"}';
      if (broken === '{}') fs.unlinkSync(file('users.json'));
      else fs.writeFileSync(file('users.json'), broken);
      await assert.rejects(auth.getUserByPasscode('admin'));
      assert.equal(auth.getUserFromSessionToken(token), null);
    }
    fresh();
    fs.writeFileSync(file('credentials-initialized.json'), 'null');
    await assert.rejects(auth.getUserByPasscode('admin'));
  });
  await t.test('failed migration preserves the legacy credential', async t => {
    fresh();
    const legacy = crypto.createHmac('sha256', process.env.ARCHIVE_AUTH_SECRET).update('existing-password').digest('base64url');
    json.writeJsonAtomic(file('users.json'), { adam: legacy });
    const before = fs.readFileSync(file('users.json'));
    const original = json.writeJsonAtomic;
    t.mock.method(json, 'writeJsonAtomic', (target, value) => {
      if (target === file('users.json')) throw new Error('Disk unavailable');
      return original(target, value);
    });
    await assert.rejects(auth.getUserByPasscode('existing-password'), /Disk unavailable/);
    assert.deepEqual(fs.readFileSync(file('users.json')), before);
  });
  await t.test('reset revokes sessions even when resetting to the same password', async () => {
    fresh();
    await auth.setUserPasscode('adam', 'existing-password');
    const token = auth.createSessionToken('adam');
    assert.equal(auth.getUserFromSessionToken(token).id, 'adam');
    assert.equal(auth.getUserFromSessionToken(token.replace('v3.', 'v2.')), null);
    assert.equal(auth.getUserFromSessionToken(token + 'tampered'), null);
    await auth.setUserPasscode('adam', 'existing-password');
    assert.equal(auth.getUserFromSessionToken(token), null);
    assert.equal(auth.getUserFromSessionToken(auth.createSessionToken('adam')).id, 'adam');
  });
  await t.test('parallel account creation cannot duplicate passwords', async () => {
    fresh();
    const results = await Promise.allSettled([auth.createUser('One', 'unique-password'), auth.createUser('Two', 'unique-password')]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  });
});

test('login throttle trust and concurrency', async t => {
  await t.test('spoofed forwarding addresses share the default bucket', () => {
    fresh();
    for (let i = 0; i < 7; i++) limiter.recordFailedLogin(req({ 'x-forwarded-for': `192.0.2.${i}` }));
    assert.equal(limiter.getLoginRateLimitStatus(req({ 'x-real-ip': '198.51.100.1' })).locked, true);
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(file('login-attempts.json')))).length, 1);
  });
  await t.test('configured single proxy addresses separate clients; chains are untrusted', () => {
    fresh(); process.env.ARCHIVE_TRUSTED_IP_HEADER = 'x-real-ip';
    for (let i = 0; i < 7; i++) limiter.recordFailedLogin(req({ 'x-real-ip': '192.0.2.1' }));
    assert.equal(limiter.getLoginRateLimitStatus(req({ 'x-real-ip': '192.0.2.2' })).locked, false);
    for (let i = 0; i < 7; i++) limiter.recordFailedLogin(req({ 'x-real-ip': `192.0.2.${i}, 127.0.0.1` }));
    assert.equal(limiter.getLoginRateLimitStatus(req({})).locked, true);
    fs.writeFileSync(file('login-attempts.json'), '{');
    assert.throws(() => limiter.getLoginRateLimitStatus(req({})));
  });
  await t.test('parallel login attempts reserve capacity before password work', async () => {
    fresh(); await auth.setUserPasscode('adam', 'existing-password');
    const responses = await Promise.all(Array.from({ length: 12 }, () => session.POST(new NextRequest('http://test.local/api/session', { method: 'POST', body: JSON.stringify({ passcode: 'incorrect' }) }))));
    assert.equal(responses.filter(r => r.status === 401).length, 6);
    assert.equal(responses.filter(r => r.status === 429).length, 6);
  });
});

test('processing limits and process failures', async t => {
  await t.test('queue bounds concurrency and releases slots after rejection', async () => {
    const limit = new TaskLimiter(1, 1);
    let release;
    const first = limit.run(() => new Promise(resolve => { release = resolve; }));
    let entered = false;
    const second = limit.run(async () => { entered = true; throw new Error('job failed'); });
    const rejection = assert.rejects(second, /job failed/);
    await assert.rejects(limit.run(async () => {}), /busy/);
    assert.equal(entered, false); release(); await first; await rejection;
    assert.equal(await limit.run(async () => 42), 42);
  });
  await t.test('timeout, callback error and diagnostics are bounded', async t => {
    const { EventEmitter } = require('node:events');
    const { PassThrough } = require('node:stream');
    let child;
    t.mock.method(require('node:child_process'), 'spawn', () => {
      child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = signal => { assert.equal(signal, 'SIGKILL'); setImmediate(() => child.emit('close', null)); return true; };
      return child;
    });
    await assert.rejects(audio.runFfmpeg([], undefined, 10), /timed out/);
    const callback = audio.runFfmpeg([], () => { throw new Error('bad samples'); });
    child.stdout.write(Buffer.alloc(4)); await assert.rejects(callback, /bad samples/);
    const diagnostic = audio.runFfmpeg([]);
    child.stderr.write(Buffer.alloc(100000, 'x')); child.emit('close', 1);
    await assert.rejects(diagnostic, error => error.message.length === 65536);
  });
});

const wav = () => {
  const buffer = Buffer.alloc(2044);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(1000, 24); buffer.writeUInt32LE(2000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(2000, 40); buffer.writeInt16LE(16384, 44);
  return buffer;
};
test('WAV fallback validates frames and chunk boundaries without crashing', async () => {
  fresh(); process.env.ARCHIVE_FFMPEG_PATH = path.join(scratch, 'missing-ffmpeg');
  const target = file('fixture.wav'); fs.writeFileSync(target, wav());
  const result = await waveform.generateServerWaveform(target);
  assert.equal(result.waveformDuration, 1); assert.equal(result.generator, 'wav-parser');
  assert.ok(result.waveformPeaks[0].some(value => value === .5));
  for (const mutate of [b => b.writeUInt16LE(1, 32), b => b.writeUInt16LE(12, 34), b => b.writeUInt32LE(2001, 40), b => b.writeUInt32LE(9000, 4), b => b.writeUInt16LE(0, 22)]) {
    const buffer = wav(); mutate(buffer); fs.writeFileSync(target, buffer);
    await assert.rejects(waveform.generateServerWaveform(target));
  }
});

test('WAV sample callback exceptions reject without escaping the stream', async t => {
  fresh(); process.env.ARCHIVE_FFMPEG_PATH = path.join(scratch, 'missing-ffmpeg');
  const target = file('fixture.wav'); fs.writeFileSync(target, wav());
  t.mock.method(Buffer.prototype, 'readInt16LE', () => { throw new Error('Injected sample error'); });
  await assert.rejects(waveform.generateServerWaveform(target), /Injected sample error/);
});
