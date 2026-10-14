import { spawn } from 'child_process';
import { getTaskLimiter } from './task-limiter';

export const runAudioJob = <T,>(task: () => Promise<T>) => getTaskLimiter('audio', 2, 8).run(task);
export const MAX_AUDIO_SECONDS = 4 * 60 * 60;

/** Called inside runAudioJob; no shell, bounded diagnostics/output and wall time. */
export const runFfmpeg = (args: string[], onData?: (chunk: Buffer) => void, timeoutMs = 120000) => (
  new Promise<void>((resolve, reject) => {
    const child = spawn(process.env.ARCHIVE_FFMPEG_PATH || 'ffmpeg', [
      '-nostdin', '-hide_banner', '-v', 'error', '-threads', '1', ...args,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = Buffer.alloc(0);
    let outputBytes = 0;
    let failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop(new Error('Audio processing timed out')), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return;
      try {
        outputBytes += chunk.length;
        if (outputBytes > MAX_AUDIO_SECONDS * 8000 * 4) throw new Error('Decoded audio exceeds processing limit');
        onData?.(chunk);
      } catch (error) {
        stop(error instanceof Error ? error : new Error('Invalid decoded audio'));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (diagnostics.length < 65536) diagnostics = Buffer.concat([diagnostics, chunk.subarray(0, 65536 - diagnostics.length)]);
    });
    child.stdout.on('error', stop);
    child.stderr.on('error', stop);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(diagnostics.toString('utf8').trim() || `ffmpeg exited with code ${code}`));
      else resolve();
    });
  })
);
