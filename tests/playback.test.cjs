/* eslint-disable @typescript-eslint/no-require-imports */
// Compile the real playback helpers with the project's installed TypeScript.
// No server, real credentials, or production storage are used by these tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
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
