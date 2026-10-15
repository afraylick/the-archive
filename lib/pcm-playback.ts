import { readAudioRange } from './audio-range';
import { MAX_AUDIO_SECONDS, runAudioJob, runFfmpeg } from './audio-processing';

export const PCM_SAMPLE_RATE = 48000;
export const PCM_FRAME_BYTES = 4; // stereo, signed 16-bit
export const PCM_CHUNK_BYTES = 4 * 1024 * 1024;
const HEADER_BYTES = 44;

export const createPcmHeader = (duration: number) => {
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_AUDIO_SECONDS) throw new Error('Invalid playback duration');
  const frames = Math.round(duration * PCM_SAMPLE_RATE);
  const dataBytes = frames * PCM_FRAME_BYTES;
  const header = Buffer.alloc(HEADER_BYTES);
  header.write('RIFF'); header.writeUInt32LE(dataBytes + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(PCM_SAMPLE_RATE, 24); header.writeUInt32LE(PCM_SAMPLE_RATE * PCM_FRAME_BYTES, 28);
  header.writeUInt16LE(PCM_FRAME_BYTES, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(dataBytes, 40);
  return { header, size: HEADER_BYTES + dataBytes };
};

/** Decode only this byte window, including one second of resampler preroll. */
export const readPcmWindow = async (sourcePath: string, header: Buffer, start: number, end: number, signal: AbortSignal) => {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start + 1 > PCM_CHUNK_BYTES) throw new Error('Invalid PCM window');
  signal.throwIfAborted();
  const parts: Buffer[] = [];
  if (start < HEADER_BYTES) parts.push(header.subarray(start, Math.min(end + 1, HEADER_BYTES)));
  if (end >= HEADER_BYTES) {
    const dataStart = Math.max(start, HEADER_BYTES) - HEADER_BYTES;
    const dataEnd = end - HEADER_BYTES;
    const firstFrame = Math.floor(dataStart / PCM_FRAME_BYTES);
    const frameCount = Math.ceil((dataEnd + 1) / PCM_FRAME_BYTES) - firstFrame;
    const seekSeconds = Math.max(0, Math.floor(firstFrame / PCM_SAMPLE_RATE) - 1);
    const skipFrames = firstFrame - seekSeconds * PCM_SAMPLE_RATE;
    const wantedBytes = frameCount * PCM_FRAME_BYTES;
    const chunks: Buffer[] = [];
    let received = 0;
    await runAudioJob(() => runFfmpeg([
      '-protocol_whitelist', 'file,pipe', '-ss', String(seekSeconds),
      '-t', String((skipFrames + frameCount) / PCM_SAMPLE_RATE + 0.1), '-i', /* turbopackIgnore: true */ sourcePath,
      '-vn', '-map', '0:a:0', '-ac', '2',
      '-af', `aresample=${PCM_SAMPLE_RATE},atrim=start_sample=${skipFrames}:end_sample=${skipFrames + frameCount}`,
      '-codec:a', 'pcm_s16le', '-f', 's16le', 'pipe:1',
    ], chunk => {
      received += chunk.length;
      if (received > wantedBytes) throw new Error('PCM window exceeded its byte limit');
      chunks.push(Buffer.from(chunk));
    }, 15000, signal));
    signal.throwIfAborted();
    // The 8 kHz waveform duration can round the final frame by a few samples.
    // Permit only that tiny tail difference, never hide an incomplete decode.
    if (received < wantedBytes && wantedBytes - received > PCM_FRAME_BYTES * 8) throw new Error('Incomplete PCM window');
    const pcm = Buffer.concat(chunks, wantedBytes);
    const offset = dataStart - firstFrame * PCM_FRAME_BYTES;
    parts.push(pcm.subarray(offset, offset + dataEnd - dataStart + 1));
  }
  return Buffer.concat(parts);
};

/** Stable WAV byte offsets provide precise native seeking in Safari and Firefox. */
export const streamPcmPlayback = async (sourcePath: string, duration: number, req: Request) => {
  const { header, size } = createPcmHeader(duration);
  const range = readAudioRange(req.headers.get('range'), size);
  const headers: Record<string, string> = {
    'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'Vary': 'Cookie',
  };
  if (req.method === 'HEAD') return new Response(null, { headers: { ...headers, 'Content-Length': String(size) } });
  if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
  if (range) {
    // RFC 9110 permits a portion of the requested range; browsers request the
    // remainder as needed. Each job and response stays below four MiB.
    const end = Math.min(range.end, range.start + PCM_CHUNK_BYTES - 1);
    const bytes = await readPcmWindow(sourcePath, header, range.start, end, req.signal);
    return new Response(bytes, { status: 206, headers: {
      ...headers, 'Content-Length': String(bytes.length), 'Content-Range': `bytes ${range.start}-${end}/${size}`,
    } });
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.signal.addEventListener('abort', abort, { once: true });
  if (req.signal.aborted) abort();
  let position = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(stream) {
      try {
        const end = Math.min(size - 1, position + PCM_CHUNK_BYTES - 1);
        stream.enqueue(await readPcmWindow(sourcePath, header, position, end, controller.signal));
        position = end + 1;
        if (position >= size) { req.signal.removeEventListener('abort', abort); stream.close(); }
      } catch (error) { req.signal.removeEventListener('abort', abort); stream.error(error); }
    },
    cancel() { req.signal.removeEventListener('abort', abort); abort(); },
  });
  return new Response(body, { headers: { ...headers, 'Content-Length': String(size) } });
};
