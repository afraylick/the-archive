import fs from 'fs';
import path from 'path';
import { runAudioJob, runFfmpeg } from '@/lib/audio-processing';
import { ensureDir, getIndexedMp3CachePath } from '@/lib/storage';

const jobs = (globalThis as typeof globalThis & { archiveIndexedAudioJobs?: Map<string, Promise<void>> });
jobs.archiveIndexedAudioJobs ??= new Map();

/** Add a frame-count/seek header without re-encoding or changing the uploaded MP3. */
export const getIndexedMp3Path = async (sourcePath: string, id: string) => {
  const sourceStat = fs.statSync(sourcePath);
  const outputPath = getIndexedMp3CachePath(id);
  const outputStat = fs.existsSync(outputPath) ? fs.statSync(outputPath) : null;
  if (outputStat && outputStat.size > 0 && outputStat.mtimeMs >= sourceStat.mtimeMs) return outputPath;

  let pending = jobs.archiveIndexedAudioJobs!.get(outputPath);
  if (!pending) {
    pending = runAudioJob(async () => {
      ensureDir(path.dirname(outputPath));
      const tempPath = `${outputPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        await runFfmpeg([
          '-y', '-protocol_whitelist', 'file,pipe', '-i', /* turbopackIgnore: true */ sourcePath,
          '-map', '0:a:0', '-vn', '-map_metadata', '-1', '-codec:a', 'copy',
          '-write_xing', '1', '-f', 'mp3', /* turbopackIgnore: true */ tempPath,
        ]);
        const currentStat = fs.statSync(sourcePath);
        if (currentStat.size !== sourceStat.size || currentStat.mtimeMs !== sourceStat.mtimeMs) {
          throw new Error('Recording changed while indexing playback');
        }
        fs.renameSync(tempPath, outputPath);
      } finally {
        fs.rmSync(tempPath, { force: true });
      }
    }).finally(() => jobs.archiveIndexedAudioJobs!.delete(outputPath));
    jobs.archiveIndexedAudioJobs!.set(outputPath, pending);
  }
  await pending;
  return outputPath;
};
