/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, after } = require('node:test');
const ts = require('typescript');
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const { getMp3Container, streamMp3Container } = require('../lib/mp3-mp4.ts');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'songie-mp3-test-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const fixture = (count = 6) => {
  const tag = Buffer.from([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]);
  const frames = Array.from({ length: count }, (_, i) => {
    const frame = Buffer.alloc(i % 2 ? 626 : 417, i % 255);
    frame.set([0xff, 0xfb, i % 2 ? 0xb0 : 0x90, 0]);
    return frame;
  });
  return { bytes: Buffer.concat([tag, ...frames]), frames };
};
const save = (name, bytes) => { const file = path.join(scratch, name); fs.writeFileSync(file, bytes); return file; };

test('virtual ranges cross the header/source boundary and preserve all original bytes', async () => {
  const { bytes, frames } = fixture();
  const file = save('ranges.mp3', bytes);
  const container = await getMp3Container(file);
  assert.ok(container);
  const full = Buffer.from(await streamMp3Container(file, container, null).arrayBuffer());
  assert.deepEqual(full.subarray(container.header.length), bytes);
  // Independently walk each MP4 sample's offset and size back to its source frame.
  const stco = full.indexOf('stco'), stsz = full.indexOf('stsz'), stts = full.indexOf('stts');
  assert.equal(full.readUInt32BE(stco + 8), frames.length);
  assert.equal(full.readUInt32BE(stts + 16), 1152);
  for (let i = 0; i < frames.length; i++) {
    const offset = full.readUInt32BE(stco + 12 + i * 4);
    const size = full.readUInt32BE(stsz + 16 + i * 4);
    assert.deepEqual(full.subarray(offset, offset + size), frames[i]);
  }
  const h = container.header.length;
  for (const [range, start, end] of [['bytes=0-1', 0, 1], [`bytes=${h - 4}-${h + 7}`, h - 4, h + 7], [`bytes=${h + 10}-`, h + 10, full.length - 1], ['bytes=-21', full.length - 21, full.length - 1]]) {
    const response = streamMp3Container(file, container, range);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${full.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), full.subarray(start, end + 1));
  }
  const unsatisfiable = streamMp3Container(file, container, `bytes=${full.length}-`);
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers.get('cache-control'), 'no-store');
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(fs.readdirSync(scratch).filter(name => name.startsWith('ranges')), ['ranges.mp3']);
});

test('concurrent ranges share an index; source replacement invalidates it', async () => {
  const file = save('cache.mp3', fixture().bytes);
  const values = await Promise.all(Array.from({ length: 8 }, () => getMp3Container(file)));
  assert.ok(values.every(value => value === values[0]));
  fs.writeFileSync(file, fixture(9).bytes);
  const replaced = await getMp3Container(file);
  assert.notEqual(replaced, values[0]);
  assert.equal(replaced.sourceSize, fixture(9).bytes.length);
});

test('truncated, corrupt, changing-format and unsupported MP3s decline wrapping', async () => {
  const valid = fixture().bytes;
  const changed = Buffer.from(valid); changed[10 + 417 + 2] |= 4; // change sample rate
  for (const [i, bytes] of [Buffer.from('ID3'), valid.subarray(0, -1), Buffer.concat([valid.subarray(0, 500), Buffer.from('broken'), valid.subarray(500)]), changed].entries()) {
    assert.equal(await getMp3Container(save(`bad-${i}.mp3`, bytes)), null);
  }
});

test('long tracks build sample tables without spreading hundreds of thousands of arguments', async () => {
  const file = save('long.mp3', fixture(150000).bytes);
  const container = await getMp3Container(file);
  assert.ok(container);
  assert.ok(container.header.length < 150000 * 9);
});

test('real CBR/VBR and MPEG-2 frames decode identically through the virtual MP4', async t => {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('ffmpeg unavailable');
  const ffmpeg = args => {
    const result = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', ...args], { maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr?.toString());
    return result.stdout;
  };
  for (const [name, rate, encoding] of [['vbr', 44100, ['-q:a', '4']], ['cbr', 48000, ['-b:a', '192k']], ['mpeg2', 22050, ['-q:a', '4']]]) {
    const file = path.join(scratch, `${name}.mp3`);
    ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=431:sample_rate=${rate}:duration=4`, '-codec:a', 'libmp3lame', ...encoding, file]);
    const container = await getMp3Container(file);
    assert.ok(container, name);
    const virtual = save(`${name}.mp4`, Buffer.from(await streamMp3Container(file, container, null).arrayBuffer()));
    const original = ffmpeg(['-i', file, '-f', 'f32le', '-ac', '1', 'pipe:1']);
    const remuxed = ffmpeg(['-i', virtual, '-f', 'f32le', '-ac', '1', 'pipe:1']);
    // MP4's edit list defines the end. ffmpeg's raw PCM muxer can emit the
    // remaining codec padding after it; compare the declared playback window.
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', virtual]);
    assert.equal(probe.status, 0);
    assert.equal(Number(JSON.parse(probe.stdout).format.duration), 4, `${name}: gapless duration`);
    assert.ok(remuxed.subarray(0, original.length).equals(original), `${name}: identical PCM throughout the playback window`);
    assert.ok(remuxed.length >= original.length && remuxed.length - original.length <= 2304 * 4, `${name}: only bounded encoder padding remains`);
  }
});
