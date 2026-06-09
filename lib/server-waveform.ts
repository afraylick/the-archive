import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { roundWaveformPeak, WAVEFORM_GENERATION_SAMPLE_RATE, WAVEFORM_PEAK_LENGTH } from '@/lib/waveform';

interface WaveFormat {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  validBitsPerSample: number;
  blockAlign: number;
}

interface WaveDataChunk {
  offset: number;
  size: number;
}

export interface GeneratedWaveform {
  waveformPeaks: number[][];
  waveformDuration: number;
  generator: 'ffmpeg' | 'wav-parser';
}

const getCommand = (envName: string, fallback: string) => process.env[envName] || fallback;
const FFMPEG_PEAK_BLOCK_SIZE = 64;

const resampleBlockPeaks = (blockPeaks: number[], blockSize: number, totalSamples: number) => {
  const peaks = new Array<number>(WAVEFORM_PEAK_LENGTH).fill(0);
  const samplesPerPeak = totalSamples / WAVEFORM_PEAK_LENGTH;

  for (let i = 0; i < WAVEFORM_PEAK_LENGTH; i++) {
    const startSample = i * samplesPerPeak;
    const endSample = (i + 1) * samplesPerPeak;
    const startBlock = Math.max(0, Math.floor(startSample / blockSize));
    const endBlock = Math.min(blockPeaks.length - 1, Math.max(startBlock, Math.ceil(endSample / blockSize) - 1));

    for (let blockIndex = startBlock; blockIndex <= endBlock; blockIndex++) {
      const blockPeak = blockPeaks[blockIndex] || 0;
      if (Math.abs(blockPeak) > Math.abs(peaks[i])) {
        peaks[i] = blockPeak;
      }
    }
  }

  return peaks.map(roundWaveformPeak);
};

const generateWithFfmpeg = async (filePath: string): Promise<GeneratedWaveform> => {
  const blockPeaks: number[] = [];
  let totalSamples = 0;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(getCommand('ARCHIVE_FFMPEG_PATH', 'ffmpeg'), [
      '-hide_banner',
      '-v',
      'error',
      '-i',
      /* turbopackIgnore: true */ filePath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      String(WAVEFORM_GENERATION_SAMPLE_RATE),
      '-f',
      'f32le',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const stderr: Buffer[] = [];
    let leftover = Buffer.alloc(0);
    let blockPeak = 0;
    let blockSampleCount = 0;

    const pushBlockPeak = () => {
      blockPeaks.push(blockPeak);
      blockPeak = 0;
      blockSampleCount = 0;
    };

    child.stdout.on('data', chunk => {
      const buffer = leftover.length ? Buffer.concat([leftover, Buffer.from(chunk)]) : Buffer.from(chunk);
      const sampleBytes = buffer.length - (buffer.length % 4);

      for (let offset = 0; offset < sampleBytes; offset += 4) {
        const sample = buffer.readFloatLE(offset);
        const amplitude = Math.abs(Number.isFinite(sample) ? sample : 0);
        if (amplitude > Math.abs(blockPeak)) {
          blockPeak = Number.isFinite(sample) ? sample : 0;
        }
        blockSampleCount++;
        totalSamples++;

        if (blockSampleCount >= FFMPEG_PEAK_BLOCK_SIZE) {
          pushBlockPeak();
        }
      }

      leftover = sampleBytes < buffer.length ? buffer.subarray(sampleBytes) : Buffer.alloc(0);
    });

    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', code => {
      if (blockSampleCount > 0) {
        pushBlockPeak();
      }

      if (code === 0 && totalSamples > 0) {
        resolve();
        return;
      }

      const message = Buffer.concat(stderr).toString('utf8').trim() || `ffmpeg exited with code ${code}`;
      reject(new Error(message));
    });
  });

  const duration = totalSamples / WAVEFORM_GENERATION_SAMPLE_RATE;
  return {
    waveformPeaks: [resampleBlockPeaks(blockPeaks, FFMPEG_PEAK_BLOCK_SIZE, totalSamples)],
    waveformDuration: duration,
    generator: 'ffmpeg',
  };
};

const readChunkHeader = (fd: number, position: number) => {
  const buffer = Buffer.alloc(8);
  const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
  if (bytesRead < buffer.length) return null;
  return {
    id: buffer.toString('ascii', 0, 4),
    size: buffer.readUInt32LE(4),
  };
};

const readWaveMetadata = (filePath: string) => {
  const fd = fs.openSync(/* turbopackIgnore: true */ filePath, 'r');
  try {
    const header = Buffer.alloc(12);
    if (fs.readSync(fd, header, 0, header.length, 0) < header.length) {
      throw new Error('Invalid WAV header');
    }
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('Unsupported WAV container');
    }

    const stat = fs.fstatSync(fd);
    let position = 12;
    let format: WaveFormat | null = null;
    let dataChunk: WaveDataChunk | null = null;

    while (position + 8 <= stat.size) {
      const chunk = readChunkHeader(fd, position);
      if (!chunk) break;

      const chunkDataOffset = position + 8;
      if (chunk.id === 'fmt ') {
        const fmt = Buffer.alloc(Math.min(chunk.size, 40));
        fs.readSync(fd, fmt, 0, fmt.length, chunkDataOffset);
        if (fmt.length < 16) {
          throw new Error('Invalid WAV fmt chunk');
        }
        const declaredFormat = fmt.readUInt16LE(0);
        const extensibleFormat = declaredFormat === 0xfffe && fmt.length >= 40
          ? fmt.readUInt16LE(24)
          : declaredFormat;
        format = {
          audioFormat: extensibleFormat,
          channels: fmt.readUInt16LE(2),
          sampleRate: fmt.readUInt32LE(4),
          blockAlign: fmt.readUInt16LE(12),
          bitsPerSample: fmt.readUInt16LE(14),
          validBitsPerSample: declaredFormat === 0xfffe && fmt.length >= 20
            ? fmt.readUInt16LE(18) || fmt.readUInt16LE(14)
            : fmt.readUInt16LE(14),
        };
      } else if (chunk.id === 'data') {
        dataChunk = { offset: chunkDataOffset, size: chunk.size };
        break;
      }

      position = chunkDataOffset + chunk.size + (chunk.size % 2);
    }

    if (!format || !dataChunk) throw new Error('WAV format/data chunk not found');
    if (![1, 3].includes(format.audioFormat)) throw new Error('Only PCM and float WAV files are supported without ffmpeg');
    if (format.channels < 1 || format.sampleRate <= 0 || format.blockAlign <= 0) throw new Error('Invalid WAV format');

    return { format, dataChunk };
  } finally {
    fs.closeSync(fd);
  }
};

const readPcmSample = (buffer: Buffer, offset: number, bitsPerSample: number) => {
  if (bitsPerSample === 8) return (buffer.readUInt8(offset) - 128) / 128;
  if (bitsPerSample === 16) return buffer.readInt16LE(offset) / 32768;
  if (bitsPerSample === 24) return buffer.readIntLE(offset, 3) / 8388608;
  if (bitsPerSample === 32) return buffer.readInt32LE(offset) / 2147483648;
  return 0;
};

const readFloatSample = (buffer: Buffer, offset: number, bitsPerSample: number) => {
  if (bitsPerSample === 32) return buffer.readFloatLE(offset);
  if (bitsPerSample === 64) return buffer.readDoubleLE(offset);
  return 0;
};

const generateWithWaveParser = async (filePath: string): Promise<GeneratedWaveform> => {
  if (path.extname(filePath).toLowerCase() !== '.wav') {
    throw new Error('Built-in waveform parser only supports WAV files');
  }

  const { format, dataChunk } = readWaveMetadata(filePath);
  const totalFrames = Math.max(1, Math.floor(dataChunk.size / format.blockAlign));
  const duration = totalFrames / format.sampleRate;
  const sampleBytes = Math.max(1, Math.floor(format.blockAlign / format.channels));
  const peaks = new Array<number>(WAVEFORM_PEAK_LENGTH).fill(0);

  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(/* turbopackIgnore: true */ filePath, {
      start: dataChunk.offset,
      end: dataChunk.offset + dataChunk.size - 1,
      highWaterMark: 1024 * 1024,
    });
    let leftover = Buffer.alloc(0);
    let frameIndex = 0;

    stream.on('data', chunk => {
      const buffer = leftover.length ? Buffer.concat([leftover, Buffer.from(chunk)]) : Buffer.from(chunk);
      const frameBytes = buffer.length - (buffer.length % format.blockAlign);

      for (let offset = 0; offset < frameBytes; offset += format.blockAlign) {
        let peak = 0;
        for (let channel = 0; channel < format.channels; channel++) {
          const sampleOffset = offset + channel * sampleBytes;
          const sample = format.audioFormat === 3
            ? readFloatSample(buffer, sampleOffset, format.bitsPerSample)
            : readPcmSample(buffer, sampleOffset, format.bitsPerSample);
          if (Math.abs(sample) > Math.abs(peak)) peak = sample;
        }

        const bucket = Math.min(WAVEFORM_PEAK_LENGTH - 1, Math.floor((frameIndex / totalFrames) * WAVEFORM_PEAK_LENGTH));
        if (Math.abs(peak) > Math.abs(peaks[bucket])) {
          peaks[bucket] = peak;
        }
        frameIndex++;
      }

      leftover = frameBytes < buffer.length ? buffer.subarray(frameBytes) : Buffer.alloc(0);
    });

    stream.on('error', reject);
    stream.on('end', () => {
      if (frameIndex <= 0) {
        reject(new Error('No WAV frames read'));
        return;
      }
      resolve();
    });
  });

  return {
    waveformPeaks: [peaks.map(roundWaveformPeak)],
    waveformDuration: duration,
    generator: 'wav-parser',
  };
};

export const generateServerWaveform = async (filePath: string): Promise<GeneratedWaveform> => {
  try {
    return await generateWithFfmpeg(filePath);
  } catch (ffmpegError) {
    try {
      return await generateWithWaveParser(filePath);
    } catch (waveError) {
      throw new Error(`Waveform generation failed. ffmpeg: ${(ffmpegError as Error).message}; wav parser: ${(waveError as Error).message}`);
    }
  }
};
