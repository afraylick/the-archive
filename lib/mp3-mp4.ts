import fs from 'node:fs';
import { Readable } from 'node:stream';
import { getTaskLimiter } from './task-limiter';
import { readAudioRange } from './audio-range';

// Firefox's raw MP3 demuxer estimates timestamps from average frame sizes, even
// with a Xing TOC. An MP4 sample table gives it exact timestamps. Only the small
// container header is retained: mdat is streamed directly from the original MP3.
const MAX_SECONDS = 4 * 60 * 60;
const MAX_SOURCE_BYTES = 1024 * 1024 * 1024;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 64;
const u32 = (...values: number[]) => {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => b.writeUInt32BE(value, i * 4));
  return b;
};
const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length + 8), Buffer.from(type), body]);
};
const fullBox = (type: string, ...parts: Buffer[]) => box(type, u32(0), ...parts);
const matrix = u32(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);

interface FrameFormat { sampleRate: number; samples: number; channels: number; size: number }
function frameFormat(b: Buffer): FrameFormat | null {
  if (b.length < 4) return null;
  const h = b.readUInt32BE(0);
  const version = (h >>> 19) & 3;
  const rateIndex = (h >>> 10) & 3;
  const bitrateIndex = (h >>> 12) & 15;
  if (h >>> 21 !== 0x7ff || version === 1 || ((h >>> 17) & 3) !== 1 ||
      rateIndex === 3 || bitrateIndex === 0 || bitrateIndex === 15) return null;
  const sampleRate = [44100, 48000, 32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const bitrate = (version === 3
    ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[bitrateIndex];
  return { sampleRate, samples: version === 3 ? 1152 : 576,
    channels: ((h >>> 6) & 3) === 3 ? 1 : 2,
    size: Math.floor((version === 3 ? 144000 : 72000) * bitrate / sampleRate) + ((h >>> 9) & 1) };
}

interface Mp3Index {
  offsets: number[]; sizes: number[]; format: FrameFormat;
  delay: number; padding: number; sourceSize: number;
}

async function indexMp3(filePath: string): Promise<Mp3Index | null> {
  const file = await fs.promises.open(/* turbopackIgnore: true */ filePath, 'r');
  try {
    const { size } = await file.stat();
    if (size < 4 || size > MAX_SOURCE_BYTES) return null;
    let buffer = Buffer.alloc(0), bufferStart = 0;
    // Scan headers with bounded I/O, without decoding or retaining audio data.
    const read = async (offset: number, length: number) => {
      if (offset < bufferStart || offset + length > bufferStart + buffer.length) {
        const next = Buffer.alloc(Math.max(65536, length));
        const { bytesRead } = await file.read(next, 0, next.length, offset);
        buffer = next.subarray(0, bytesRead); bufferStart = offset;
      }
      return buffer.subarray(offset - bufferStart, offset - bufferStart + length);
    };
    let position = 0;
    const tag = await read(0, 10);
    if (tag.toString('ascii', 0, 3) === 'ID3') {
      if (tag.length < 10) return null;
      if (![2, 3, 4].includes(tag[3]) || [...tag.subarray(6, 10)].some(v => v & 128)) return null;
      position = 10 + ((tag[6] << 21) | (tag[7] << 14) | (tag[8] << 7) | tag[9]);
      if (tag[3] === 4 && (tag[5] & 16)) position += 10;
    }
    const offsets: number[] = [], sizes: number[] = [];
    let format: FrameFormat | null = null;
    let delay = 0, padding = 0, first = true;
    const deadline = Date.now() + 30000;
    while (position + 4 <= size) {
      if (Date.now() > deadline) throw new Error('MP3 indexing timed out');
      const header = await read(position, 4);
      const frame = frameFormat(header);
      if (!frame) {
        const tail = await read(position, 8);
        // Known trailing metadata is outside the sample table.
        if ((size - position === 128 && tail.toString('ascii', 0, 3) === 'TAG') ||
            tail.toString('ascii') === 'APETAGEX') break;
        return null;
      }
      if (position + frame.size > size) return null;
      if (format && (format.sampleRate !== frame.sampleRate || format.samples !== frame.samples || format.channels !== frame.channels)) return null;
      format = frame;
      let metadataFrame = false;
      if (first) {
        const data = await read(position, frame.size);
        const sideInfo = frame.samples === 1152 ? (frame.channels === 1 ? 17 : 32) : (frame.channels === 1 ? 9 : 17);
        const xing = 4 + sideInfo;
        const name = data.toString('ascii', xing, xing + 4);
        metadataFrame = name === 'Xing' || name === 'Info' || data.toString('ascii', 36, 40) === 'VBRI';
        if (name === 'Xing' || name === 'Info') {
          if (data.length < xing + 8) return null;
          const flags = data.readUInt32BE(xing + 4);
          const encoder = xing + 8 + ((flags & 1) ? 4 : 0) + ((flags & 2) ? 4 : 0) + ((flags & 4) ? 100 : 0) + ((flags & 8) ? 4 : 0);
          if (encoder + 24 <= data.length && /^(LAME|Lavc|Lavf)/.test(data.toString('ascii', encoder, encoder + 4))) {
            const gapless = data.readUIntBE(encoder + 21, 3);
            // Match ffmpeg's waveform timeline (encoder plus decoder delay).
            delay = (gapless >>> 12) + 529;
            padding = Math.max(0, (gapless & 0xfff) - 529);
          }
        }
        first = false;
      }
      if (!metadataFrame) { offsets.push(position); sizes.push(frame.size); }
      position += frame.size;
      if (offsets.length * frame.samples / frame.sampleRate > MAX_SECONDS) return null;
    }
    if (!format || offsets.length < 3 || offsets.length * format.samples <= delay + padding) return null;
    return { offsets, sizes, format, delay, padding, sourceSize: size };
  } finally { await file.close(); }
}

function makeHeader(index: Mp3Index) {
  const { format, offsets, sizes, delay, padding, sourceSize } = index;
  const samples = sizes.length * format.samples;
  const duration = samples - delay - padding;
  const ftyp = box('ftyp', Buffer.from('isom'), u32(0x200), Buffer.from('isomiso2mp41'));
  const mvhd = fullBox('mvhd', u32(0, 0, format.sampleRate, duration, 0x10000), Buffer.from([1, 0]), Buffer.alloc(10), matrix, Buffer.alloc(24), u32(2));
  const tkhd = box('tkhd', u32(3, 0, 0, 1, 0, duration), Buffer.alloc(8), Buffer.from([0, 0, 0, 0, 1, 0, 0, 0]), matrix, u32(0, 0));
  const mdhd = fullBox('mdhd', u32(0, 0, format.sampleRate, samples), Buffer.from([0x55, 0xc4, 0, 0]));
  const hdlr = fullBox('hdlr', u32(0), Buffer.from('soun'), Buffer.alloc(12), Buffer.from('SoundHandler\0'));
  const dinf = box('dinf', fullBox('dref', u32(1), box('url ', u32(1))));
  const audioEntry = Buffer.alloc(28);
  audioEntry.writeUInt16BE(1, 6); // data reference
  audioEntry.writeUInt16BE(format.channels, 16);
  audioEntry.writeUInt16BE(16, 18);
  audioEntry.writeUInt32BE(format.sampleRate * 65536, 24);
  // ISO/IEC 14496-1 descriptors: MPEG-1 audio (0x6b), audio stream, SL config.
  const esds = fullBox('esds', Buffer.from([3, 21, 0, 1, 0, 4, 13, 0x6b, 0x15, 0, 0, 0]), u32(320000, 0), Buffer.from([6, 1, 2]));
  const stsd = fullBox('stsd', u32(1), box('mp4a', audioEntry, esds));
  const stts = fullBox('stts', u32(1, sizes.length, format.samples));
  const stsc = fullBox('stsc', u32(1, 1, 1, 1));
  const sampleSizes = Buffer.alloc(sizes.length * 4);
  sizes.forEach((size, i) => sampleSizes.writeUInt32BE(size, i * 4));
  const stsz = fullBox('stsz', u32(0, sizes.length), sampleSizes);
  const chunkOffsets = Buffer.alloc(offsets.length * 4);
  const makeMoov = () => box('moov', mvhd, box('trak', tkhd,
    box('edts', fullBox('elst', u32(1, duration, delay, 0x10000))),
    box('mdia', mdhd, hdlr, box('minf', fullBox('smhd', u32(0)), dinf,
      box('stbl', stsd, stts, stsc, stsz, fullBox('stco', u32(offsets.length), chunkOffsets))))));
  const prefixSize = ftyp.length + makeMoov().length + 8;
  offsets.forEach((offset, i) => chunkOffsets.writeUInt32BE(prefixSize + offset, i * 4));
  return Buffer.concat([ftyp, makeMoov(), u32(sourceSize + 8), Buffer.from('mdat')]);
}

interface VirtualMp4 { header: Buffer; sourceSize: number }
interface CacheEntry { signature: string; value: VirtualMp4 | null }
const state = globalThis as typeof globalThis & { archiveMp3Containers?: {
  cache: Map<string, CacheEntry>; pending: Map<string, Promise<VirtualMp4 | null>>;
} };
state.archiveMp3Containers ??= { cache: new Map(), pending: new Map() };

export async function getMp3Container(filePath: string): Promise<VirtualMp4 | null> {
  const stat = await fs.promises.stat(/* turbopackIgnore: true */ filePath);
  const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const { cache, pending } = state.archiveMp3Containers!;
  const cached = cache.get(filePath);
  if (cached?.signature === signature) {
    cache.delete(filePath); cache.set(filePath, cached);
    return cached.value;
  }
  const key = `${filePath}:${signature}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const job = getTaskLimiter('mp3-index', 2, 8).run(async () => {
    const index = await indexMp3(filePath);
    const value = index ? { header: makeHeader(index), sourceSize: index.sourceSize } : null;
    cache.delete(filePath); cache.set(filePath, { signature, value });
    let bytes = [...cache.values()].reduce((sum, entry) => sum + (entry.value?.header.length || 0), 0);
    while (bytes > MAX_CACHE_BYTES || cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value!;
      bytes -= cache.get(oldest)?.value?.header.length || 0; cache.delete(oldest);
    }
    return value;
  }).finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

/** A range addresses the virtual header followed by the unchanged original file. */
export function streamMp3Container(filePath: string, container: VirtualMp4, rangeHeader: string | null) {
  const { header, sourceSize } = container;
  const size = header.length + sourceSize;
  const range = readAudioRange(rangeHeader, size);
  const headers = { 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400', 'Vary': 'Cookie', 'Content-Type': 'audio/mp4' };
  if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { ...headers, 'Cache-Control': 'no-store', 'Content-Range': `bytes */${size}` } });
  const { start, end } = range || { start: 0, end: size - 1 };
  async function* chunks() {
    if (start < header.length) yield header.subarray(start, Math.min(end + 1, header.length));
    if (end >= header.length) {
      const stream = fs.createReadStream(/* turbopackIgnore: true */ filePath, {
        start: Math.max(0, start - header.length), end: end - header.length,
      });
      try { for await (const chunk of stream) yield chunk; }
      finally { stream.destroy(); }
    }
  }
  return new Response(Readable.toWeb(Readable.from(chunks())) as ReadableStream, {
    status: range ? 206 : 200,
    headers: { ...headers, 'Content-Length': String(end - start + 1),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) },
  });
}
