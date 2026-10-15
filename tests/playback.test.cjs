/* eslint-disable @typescript-eslint/no-require-imports */
// Compile the real playback helpers with the project's installed TypeScript.
// No server, real credentials, or production storage are used by these tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
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
const { getPlayableDuration, seekToProgress, playSafely } = load('lib/playback.ts');
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

test('long unindexed VBR MP3 gets an accurate timeline without re-encoding audio', async t => {
  if (spawnSync('ffmpeg', ['-version']).status !== 0 || spawnSync('ffprobe', ['-version']).status !== 0) {
    t.skip('ffmpeg/ffprobe are not installed'); return;
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'songie-mp3-timing-'));
  const previousStorage = process.env.ARCHIVE_STORAGE_DIR;
  process.env.ARCHIVE_STORAGE_DIR = scratch;
  t.after(() => {
    if (previousStorage === undefined) delete process.env.ARCHIVE_STORAGE_DIR;
    else process.env.ARCHIVE_STORAGE_DIR = previousStorage;
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const source = path.join(scratch, 'long-vbr.mp3');
  const encoded = spawnSync('ffmpeg', [
    '-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
    'aevalsrc=if(between(t\\,120\\,480)\\,random(0)*1.2-0.6\\,0):s=44100:d=600',
    '-codec:a', 'libmp3lame', '-q:a', '4', '-write_xing', '0', source,
  ]);
  assert.equal(encoded.status, 0, encoded.stderr.toString());
  const duration = file => {
    const result = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]);
    assert.equal(result.status, 0, result.stderr.toString());
    return Number(result.stdout.toString());
  };
  const decode = file => {
    const result = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', file, '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], { maxBuffer: 32 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr.toString());
    return result.stdout;
  };
  const originalBytes = fs.readFileSync(source);
  const originalPcm = decode(source);
  const decodedDuration = originalPcm.length / (8000 * 2);
  assert.ok(Math.abs(duration(source) - decodedDuration) > 5, 'fixture must reproduce duration estimation drift');
  const { getIndexedMp3Path } = load('lib/indexed-audio.ts');
  const [indexed, duplicate] = await Promise.all([
    getIndexedMp3Path(source, 'long-vbr.mp3'), getIndexedMp3Path(source, 'long-vbr.mp3'),
  ]);
  assert.equal(indexed, duplicate);
  assert.ok(Math.abs(duration(indexed) - decodedDuration) < 0.15, 'frame-count duration must match decoded waveform duration');
  t.diagnostic(`Duration: estimated ${duration(source).toFixed(3)}s; decoded ${decodedDuration.toFixed(3)}s; indexed ${duration(indexed).toFixed(3)}s`);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const audioHash = file => {
    const result = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', file, '-map', '0:a:0', '-codec:a', 'copy', '-f', 'hash', '-hash', 'sha256', 'pipe:1']);
    assert.equal(result.status, 0, result.stderr.toString());
    return result.stdout.toString();
  };
  assert.equal(audioHash(indexed), audioHash(source), 'compressed audio packets must be identical');
  const indexedPcm = decode(indexed);
  assert.ok(Math.abs(indexedPcm.length - originalPcm.length) / 16000 < 0.05, 'encoder padding must not introduce timeline drift');
  const firstSound = pcm => {
    for (let i = 0; i < pcm.length; i += 2) if (Math.abs(pcm.readInt16LE(i)) > 100) return i / 16000;
    return Infinity;
  };
  assert.ok(Math.abs(firstSound(indexedPcm) - firstSound(originalPcm)) < 0.05, 'audio onset must stay aligned with cached waveform');
  const seekPeak = (file, time) => {
    const result = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(time), '-i', file, '-t', '2', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1']);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(result.stdout.length, 2 * 8000 * 2, 'seek must return two seconds of audio');
    let peak = 0;
    for (let i = 0; i < result.stdout.length; i += 2) peak = Math.max(peak, Math.abs(result.stdout.readInt16LE(i)));
    return peak;
  };
  assert.ok(seekPeak(indexed, 200) > 100, 'indexed seek at 3:20 must reach the audible section');
  assert.equal(seekPeak(indexed, 490), 0, 'indexed seek at 8:10 must reach the silence after 8:00');
  assert.equal(hash(fs.readFileSync(source)), hash(originalBytes), 'uploaded recording must remain unchanged');
  const indexedMtime = fs.statSync(indexed).mtimeMs;
  assert.equal(await getIndexedMp3Path(source, 'long-vbr.mp3'), indexed);
  assert.equal(fs.statSync(indexed).mtimeMs, indexedMtime, 'subsequent playback reuses the indexed copy');
});
