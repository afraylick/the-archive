import { recordingUrl } from '@/lib/recording-url';
import type WaveSurfer from 'wavesurfer.js';

const pendingSeeks = new WeakMap<WaveSurfer, () => void>();

/** WaveSurfer leaves externally supplied audio alive; the page owns its cleanup. */
export const disposePlayer = (player: WaveSurfer) => {
  pendingSeeks.get(player)?.();
  const media = player.getMediaElement();
  try {
    media.pause();
    player.destroy();
  } finally {
    // Abort outstanding play/load requests as well as stopping current playback.
    media.removeAttribute('src');
    media.load();
  }
};

/** Scoped to the engine verified with captured audio, not Chromium or iOS WebKit. */
export const needsMp3SampleTable = (id: string, userAgent: string) => /\.mp3$/i.test(id) && /Firefox\//.test(userAgent);

/** Shared by the library and management players, including mobile/Firefox formats. */
export const getPlaybackAudioUrl = (id: string) => {
  const baseUrl = recordingUrl(`/api/files/${encodeURIComponent(id)}/audio`);
  if (typeof navigator === 'undefined') return baseUrl;
  if (needsMp3SampleTable(id, navigator.userAgent)) return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}format=mp4`;
  const mobile = /Android|webOS|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  return mobile ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}format=mobile` : baseUrl;
};

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
export const seekAndPlay = (player: WaveSurfer, progress: number, fallback = 0) => {
  pendingSeeks.get(player)?.();
  player.pause();
  const media = player.getMediaElement();
  return new Promise<void>((resolve) => {
    const cleanup = () => {
      clearTimeout(timer);
      media.removeEventListener('seeked', complete);
      media.removeEventListener('error', cancel);
      player.un('destroy', cancel);
      if (pendingSeeks.get(player) === cancel) pendingSeeks.delete(player);
    };
    const cancel = () => { cleanup(); resolve(); };
    const complete = () => {
      cleanup();
      // setTime emits the requested time synchronously. Reconcile to the media
      // clock only after the browser has actually resolved the seek.
      player.getRenderer().renderProgress(
        media.currentTime / (getPlayableDuration(player, fallback) || 1), false
      );
      void playSafely(player).then(resolve);
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
  try {
    await player.play();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return;
    player.getMediaElement().dispatchEvent(new Event('archiveplaybackerror'));
  }
};
