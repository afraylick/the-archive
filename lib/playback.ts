import type WaveSurfer from 'wavesurfer.js';
import { cancelAccuratePreparation, prepareAccurateSeeking } from './accurate-seeking';

const pendingSeeks = new WeakMap<WaveSurfer, () => void>();
const seekVersions = new WeakMap<WaveSurfer, number>();

/** The media clock is authoritative; cached/decoded duration is only a startup fallback. */
export const getPlayableDuration = (player: WaveSurfer, fallback = 0) => {
  for (const value of [player.getMediaElement().duration, player.getDuration(), fallback]) {
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
};

export const getSeekTarget = (player: WaveSurfer, progress: number, fallback = 0) => {
  const safeProgress = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  const duration = getPlayableDuration(player, fallback);
  const time = duration * safeProgress;
  return { duration, progress: safeProgress, time };
};

export const seekToProgress = (player: WaveSurfer, progress: number, fallback = 0) => {
  const target = getSeekTarget(player, progress, fallback);
  player.setTime(target.time);
  return target;
};

/** Pause while the browser resolves a streamed seek; a newer click supersedes it. */
export const seekAndPlay = async (player: WaveSurfer, progress: number, fallback = 0, resume = true) => {
  const version = (seekVersions.get(player) || 0) + 1;
  seekVersions.set(player, version);
  pendingSeeks.get(player)?.();
  player.pause();
  const original = player.getMediaElement();
  try {
    if (progress > 0) await prepareAccurateSeeking(player);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) original.dispatchEvent(new Event('archiveplaybackerror'));
    return;
  }
  if (seekVersions.get(player) !== version) return;
  const media = player.getMediaElement();
  return new Promise<void>((resolve) => {
    let completed = false;
    const cleanup = () => {
      clearTimeout(timer);
      media.removeEventListener('seeked', complete);
      media.removeEventListener('error', cancel);
      player.un('destroy', cancel);
      if (pendingSeeks.get(player) === cancel) pendingSeeks.delete(player);
    };
    const cancel = () => { cleanup(); resolve(); };
    const complete = () => {
      if (completed) return;
      completed = true;
      cleanup();
      // setTime emits the requested time synchronously. Reconcile to the media
      // clock only after the browser has actually resolved the seek.
      player.getRenderer().renderProgress(
        media.currentTime / (getPlayableDuration(player, fallback) || 1), false
      );
      if (resume) void playSafely(player).then(resolve);
      else resolve();
    };
    pendingSeeks.set(player, cancel);
    media.addEventListener('seeked', complete, { once: true });
    media.addEventListener('error', cancel, { once: true });
    player.on('destroy', cancel);
    const timer = setTimeout(() => {
      cancel();
      media.dispatchEvent(new Event('archiveplaybackerror'));
    }, 30000);
    try {
      seekToProgress(player, progress, fallback);
      // Seeking to the current position may not produce a seeked event.
      if (!media.seeking) complete();
    } catch {
      cancel();
      media.dispatchEvent(new Event('archiveplaybackerror'));
    }
  });
};

/** Route rejected play promises through the same visible error UI as media errors. */
export const playSafely = async (player: WaveSurfer) => {
  seekVersions.set(player, (seekVersions.get(player) || 0) + 1);
  pendingSeeks.get(player)?.();
  cancelAccuratePreparation(player);
  try {
    await player.play();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return;
    player.getMediaElement().dispatchEvent(new Event('archiveplaybackerror'));
  }
};
