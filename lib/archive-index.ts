import fs from 'node:fs';
import { getDataFilePath } from './storage';

type RecordData = { id: string; waveformPeaks?: number[][]; [key: string]: unknown };
type Index = { path: string; signature: string; metadata: RecordData[]; byId: Map<string, RecordData>; waveforms: Map<string, Float64Array[]> };
const state = globalThis as typeof globalThis & { archiveReadIndex?: Index };
const MAX_CACHED_PEAK_BYTES = 256 * 1024 * 1024;

/** A read-only, per-process index. Atomic replacements and external edits invalidate it. */
export function getArchiveIndex(): Index {
  const file = getDataFilePath();
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    state.archiveReadIndex = undefined;
    return { path: file, signature: '', metadata: [], byId: new Map<string, RecordData>(), waveforms: new Map() };
  }
  const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  if (state.archiveReadIndex?.path === file && state.archiveReadIndex.signature === signature) return state.archiveReadIndex;
  const data: RecordData[] = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data)) throw new Error('Invalid archive metadata');
  const waveforms = new Map<string, Float64Array[]>();
  let cachedBytes = 0;
  const metadata = data.map(record => {
    const { waveformPeaks, ...fields } = record;
    if (Array.isArray(waveformPeaks) && waveformPeaks.every(channel => Array.isArray(channel))) {
      const bytes = waveformPeaks.reduce((total, channel) => total + channel.length * 8, 0);
      if (cachedBytes + bytes <= MAX_CACHED_PEAK_BYTES) {
        waveforms.set(record.id, waveformPeaks.map(channel => Float64Array.from(channel)));
        cachedBytes += bytes;
      }
    }
    return { ...fields, waveformAvailable: Boolean(waveformPeaks) } as RecordData;
  });
  const index: Index = { path: file, signature, metadata, byId: new Map(metadata.map(record => [record.id, record])), waveforms };
  state.archiveReadIndex = index;
  return index;
}

export function getIndexedWaveform(id: string) {
  const index = getArchiveIndex();
  const record = index.byId.get(id);
  if (!record) return null;
  let peaks = index.waveforms.get(id)?.map(channel => Array.from(channel));
  // Waveforms beyond the memory budget fall back to the authoritative JSON.
  if (!peaks && record.waveformAvailable) {
    const data: RecordData[] = JSON.parse(fs.readFileSync(getDataFilePath(), 'utf8'));
    peaks = data.find(item => item.id === id)?.waveformPeaks;
  }
  return { waveformPeaks: peaks, waveformDuration: record.waveformDuration, waveformCacheVersion: record.waveformCacheVersion };
}
