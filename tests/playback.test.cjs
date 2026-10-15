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
  await Promise.resolve();
  await Promise.resolve();
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
  await Promise.resolve();
  assert.deepEqual(plays, []);
  media.seeking = false; media.dispatchEvent(new Event('seeked'));
  await latest;
  assert.deepEqual(plays, [2700]);
  const destroyed = seekAndPlay(player, .1);
  await Promise.resolve();
  await Promise.resolve();
  events.get('destroy')();
  media.dispatchEvent(new Event('seeked'));
  await destroyed;
  assert.deepEqual(plays, [2700]);
});

test('Firefox MP3 scrubbing decodes once, seeks by sample time, and releases on track switch', async t => {
  const { prepareAccurateSeeking, releaseAccurateSeeking } = load('lib/accurate-seeking.ts');
  const previousContext = globalThis.AudioContext;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Firefox/145.0' } });
  const starts = []; let closed = 0; let decodes = 0; let downloads = 0;
  const buffer = { duration: 545.489, sampleRate: 44100 };
  class Context {
    currentTime = 0;
    destination = {};
    async resume() {}
    async close() { closed++; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    createBufferSource() {
      return { playbackRate: { value: 1 }, connect() {}, disconnect() {}, stop() {}, start(when, offset) { starts.push({ offset, buffer: this.buffer }); } };
    }
    async decodeAudioData() { decodes++; return buffer; }
  }
  globalThis.AudioContext = Context;
  t.mock.method(globalThis, 'fetch', async () => { downloads++; return new Response(Buffer.from('fixture')); });
  t.after(() => {
    releaseAccurateSeeking();
    globalThis.AudioContext = previousContext;
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete globalThis.navigator;
  });
  const { player, media: original } = streamedPlayer();
  original.src = 'http://test/api/files/fixture.mp3/audio'; original.pause = () => {};
  let media = original;
  player.getMediaElement = () => media;
  player.setMediaElement = value => { media = value; };
  player.getVolume = () => .5; player.getPlaybackRate = () => 1;
  const first = prepareAccurateSeeking(player);
  await Promise.all([first, prepareAccurateSeeking(player)]);
  assert.equal(downloads, 1); assert.equal(decodes, 1);
  assert.notEqual(media, original);
  media.currentTime = 242;
  await media.play();
  assert.equal(starts[0].offset, 242);
  assert.equal(starts[0].buffer, buffer, 'scrub uses the decoded sample buffer');
  media.pause(); media.currentTime = 10; await media.play();
  assert.deepEqual(starts.map(start => start.offset), [242, 10]);
  releaseAccurateSeeking(player);
  assert.equal(closed, 0, 'active track retains its buffer');
  releaseAccurateSeeking();
  assert.equal(media, original); assert.equal(original.currentTime, 10);
  assert.equal(closed, 1);
});

test('downloads reject interrupted bodies and HTTP failures before creating a download', async t => {
  const { downloadAudio } = load('lib/download-audio.ts');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(options.cache, 'no-store');
    assert.ok(url.endsWith('/audio?download=1'));
    if (calls === 1) return new Response('short', { headers: { 'content-length': '100' } });
    return new Response('unauthorized', { status: 401 });
  });
  const signal = new AbortController().signal;
  await assert.rejects(downloadAudio('fixture.mp3', 'file.mp3', signal), /interrupted/);
  await assert.rejects(downloadAudio('fixture.mp3', 'file.mp3', signal), /session expired/);
});
