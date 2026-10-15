/* eslint-disable @typescript-eslint/no-require-imports */
// Compile the real playback helpers with the project's installed TypeScript.
// No server, real credentials, or production storage are used by these tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
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
const load = name => require(path.join(root, name));
const { getPlayableDuration, seekToProgress, seekAndPlay, playSafely } = load('lib/playback.ts');
const { isValidWaveformCache, WAVEFORM_CACHE_VERSION } = load('lib/waveform.ts');
const { readAudioRange } = load('lib/audio-range.ts');
test('media duration overrides stale cached duration and seeks consistently', () => {
  const media = new EventTarget(); media.duration = 100;
  let time;
  const player = { getMediaElement: () => media, getDuration: () => 200, setTime: value => { time = value; } };
  assert.equal(getPlayableDuration(player, 300), 100);
  assert.deepEqual(seekToProgress(player, .5, 300), { duration: 100, time: 50, progress: .5 });
  assert.equal(time, 50);
  seekToProgress(player, 2); assert.equal(time, 100);
  seekToProgress(player, NaN); assert.equal(time, 0);
  media.duration = Infinity; assert.equal(getPlayableDuration(player), 200);
  player.getDuration = () => 0; assert.equal(getPlayableDuration(player, 50), 50);
});
test('old placeholder caches expire while real silent and quantized audio remain valid', () => {
  assert.equal(isValidWaveformCache([Array(4000).fill(0)], 10, 5), false);
  assert.equal(isValidWaveformCache([[0, 0]], .001, WAVEFORM_CACHE_VERSION), false);
  assert.equal(isValidWaveformCache([Array(4000).fill(0)], 10, WAVEFORM_CACHE_VERSION), true);
  assert.equal(isValidWaveformCache([Array(4000).fill(.25)], 10, WAVEFORM_CACHE_VERSION), true);
});
test('rejected playback reports an error; lifecycle cancellation does not', async () => {
  const media = new EventTarget(); let failures = 0;
  media.addEventListener('archiveplaybackerror', () => failures++);
  const player = { getMediaElement: () => media, play: async () => { throw new Error('Unsupported media'); } };
  await playSafely(player); assert.equal(failures, 1);
  player.play = async () => { throw new DOMException('Interrupted', 'AbortError'); };
  await playSafely(player); assert.equal(failures, 1);
});
test('byte ranges distinguish unsupported syntax from unsatisfiable ranges', () => {
  assert.equal(readAudioRange('bytes=0-1,4-5', 100), null);
  assert.equal(readAudioRange('bytes=-1', 0), 'unsatisfiable');
  assert.deepEqual(readAudioRange('bytes=-999', 100), { start: 0, end: 99 });
  assert.equal(readAudioRange('bytes=999999999999999999999-', 100), 'unsatisfiable');
});

const streamedPlayer = () => {
  const media = new EventTarget();
  Object.assign(media, { duration: 3600, currentTime: 0, seeking: false });
  const events = new Map();
  const plays = []; const progress = [];
  const player = {
    getMediaElement: () => media, getDuration: () => media.duration,
    pause: () => {},
    setTime: time => { media.currentTime = time; media.seeking = true; },
    getRenderer: () => ({ renderProgress: value => progress.push(value) }),
    play: async () => plays.push(media.currentTime),
    on: (name, listener) => events.set(name, listener),
    un: (name, listener) => { if (events.get(name) === listener) events.delete(name); },
  };
  return { player, media, events, plays, progress };
};
test('streamed click waits for seek completion and reconciles the actual position', async () => {
  const { player, media, plays, progress } = streamedPlayer();
  const pending = seekAndPlay(player, .5);
  assert.equal(media.currentTime, 1800);
  assert.deepEqual(plays, []);
  media.currentTime = 1800.25; media.seeking = false;
  media.dispatchEvent(new Event('seeked'));
  await pending;
  assert.deepEqual(plays, [1800.25]);
  assert.deepEqual(progress, [1800.25 / 3600]);
});
test('rapid clicks supersede pending playback; destroying a player cancels a seek', async () => {
  const { player, media, plays, events } = streamedPlayer();
  const first = seekAndPlay(player, .25);
  const latest = seekAndPlay(player, .75);
  await first;
  assert.deepEqual(plays, []);
  media.seeking = false; media.dispatchEvent(new Event('seeked'));
  await latest;
  assert.deepEqual(plays, [2700]);
  const destroyed = seekAndPlay(player, .1);
  events.get('destroy')();
  media.dispatchEvent(new Event('seeked'));
  await destroyed;
  assert.deepEqual(plays, [2700]);
});

test('PCM seeks match the full decode, support unaligned ranges, and bound each response', async t => {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) { t.skip('ffmpeg not installed'); return; }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'songie-pcm-test-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const source = path.join(scratch, 'vbr.mp3');
  const encoded = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=260', '-codec:a', 'libmp3lame', '-q:a', '3', source]);
  assert.equal(encoded.status, 0, encoded.stderr.toString());
  const full = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', source, '-ac', '2', '-ar', '48000', '-f', 's16le', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 });
  assert.equal(full.status, 0, full.stderr.toString());
  const { createPcmHeader, streamPcmPlayback, PCM_CHUNK_BYTES } = load('lib/pcm-playback.ts');
  const duration = full.stdout.length / 192000;
  const { header, size } = createPcmHeader(duration);
  assert.equal(header.toString('ascii', 0, 4), 'RIFF');
  assert.equal(header.readUInt32LE(40), full.stdout.length);
  const get = (start, end) => streamPcmPlayback(source, duration, new Request('http://test/audio', { headers: { range: `bytes=${start}-${end ?? ''}` } }));
  const start = 44 + 242 * 192000;
  const seek = await get(start, start + 192000 - 1);
  assert.equal(seek.status, 206);
  const pcm = Buffer.from(await seek.arrayBuffer());
  const reference = full.stdout.subarray(start - 44, start - 44 + pcm.length);
  // Different libav resampler versions can differ by one least-significant bit.
  for (let i = 0; i < pcm.length; i += 2) assert.ok(Math.abs(pcm.readInt16LE(i) - reference.readInt16LE(i)) <= 1);
  const odd = await get(start + 1, start + 123);
  assert.deepEqual(Buffer.from(await odd.arrayBuffer()), reference.subarray(1, 124));
  const tail = await get(size - 17, size - 1);
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), full.stdout.subarray(-17));
  const capped = await get(0);
  assert.equal(Number(capped.headers.get('content-length')), PCM_CHUNK_BYTES);
  assert.equal(capped.headers.get('content-range'), `bytes 0-${PCM_CHUNK_BYTES - 1}/${size}`);
  await capped.arrayBuffer();
  const probe = await get(0, 1);
  assert.deepEqual(Buffer.from(await probe.arrayBuffer()), header.subarray(0, 2));
  const invalid = await get(size, size + 1);
  assert.equal(invalid.status, 416);
  const head = await streamPcmPlayback(source, duration, new Request('http://test/audio', { method: 'HEAD' }));
  assert.equal(head.headers.get('content-length'), String(size));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const complete = await streamPcmPlayback(source, duration, new Request('http://test/audio'));
  assert.equal(complete.status, 200);
  const reader = complete.body.getReader();
  const first = await reader.read();
  assert.equal(first.value.length, PCM_CHUNK_BYTES);
  assert.deepEqual(Buffer.from(first.value).subarray(0, 44), header);
  await reader.cancel();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(streamPcmPlayback(source, duration, new Request('http://test/audio', { signal: controller.signal, headers: { range: `bytes=${start}-` } })), { name: 'AbortError' });
});

test('aborting an active PCM decode terminates its process and releases the processing slot', async t => {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) { t.skip('ffmpeg not installed'); return; }
  const { runFfmpeg, runAudioJob } = load('lib/audio-processing.ts');
  const controller = new AbortController();
  await assert.rejects(runAudioJob(() => runFfmpeg([
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-f', 's16le', 'pipe:1',
  ], () => controller.abort(), 5000, controller.signal)), { name: 'AbortError' });
  assert.equal(await runAudioJob(async () => 'available'), 'available');
});
