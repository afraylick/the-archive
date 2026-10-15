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
const { getPlayableDuration, seekToProgress, seekAndPlay, playSafely, needsMp3SampleTable, getPlaybackAudioUrl, disposePlayer } = load('lib/playback.ts');
const { isValidWaveformCache, WAVEFORM_CACHE_VERSION } = load('lib/waveform.ts');
const { readAudioRange } = load('lib/audio-range.ts');
test('sample table workaround targets Firefox MP3 playback only', () => {
  assert.equal(needsMp3SampleTable('track.MP3', 'Gecko/20100101 Firefox/158.0'), true);
  for (const ua of ['Version/18.5 Safari/605.1.15', 'Chrome/140.0 Safari/537.36', 'FxiOS/140.0 Mobile/15 Safari/605.1.15']) {
    assert.equal(needsMp3SampleTable('track.mp3', ua), false);
  }
  assert.equal(needsMp3SampleTable('track.wav', 'Firefox/158.0'), false);
});
test('shared audio URLs retain desktop, Firefox, phone and iPad streaming formats', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  });
  for (const [userAgent, maxTouchPoints, suffix] of [
    ['Chrome/140.0 Safari/537.36', 0, ''],
    ['Gecko/20100101 Firefox/158.0', 0, '?format=mp4'],
    ['iPhone Mobile Safari/605.1.15', 1, '?format=mobile'],
    ['Macintosh Safari/605.1.15', 5, '?format=mobile'],
    ['Macintosh Safari/605.1.15', 0, ''],
  ]) {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent, maxTouchPoints } });
    assert.equal(getPlaybackAudioUrl('track one.mp3'), `/api/files/track%20one.mp3/audio${suffix}`);
  }
});
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


test('page cleanup stops and unloads externally owned audio with the installed WaveSurfer player', async () => {
  const { pathToFileURL } = require('node:url');
  const { default: Player } = await import(pathToFileURL(path.join(root, 'node_modules/wavesurfer.js/dist/player.js')).href);
  const media = new EventTarget();
  Object.assign(media, {
    src: '/api/files/playing.wav/audio', volume: 1, muted: false, paused: false, loads: 0,
    pause() { this.paused = true; this.dispatchEvent(new Event('pause')); },
    removeAttribute(name) { if (name === 'src') this.src = ''; },
    load() { this.loads++; },
  });
  const player = new Player({ media });
  disposePlayer(player);
  assert.equal(media.paused, true);
  assert.equal(media.src, '');
  assert.equal(media.loads, 1, 'unload aborts pending browser playback and downloads');
});

test('page cleanup cancels a pending streamed seek before a late seeked event can restart playback', async () => {
  const { player, media, plays, events } = streamedPlayer();
  let paused = false; let unloaded = false;
  media.pause = () => { paused = true; };
  media.removeAttribute = name => assert.equal(name, 'src');
  media.load = () => { unloaded = true; };
  player.destroy = () => events.get('destroy')?.();
  const pending = seekAndPlay(player, .5);
  disposePlayer(player);
  media.seeking = false;
  media.dispatchEvent(new Event('seeked'));
  await pending;
  assert.equal(paused, true);
  assert.equal(unloaded, true);
  assert.deepEqual(plays, []);
});
