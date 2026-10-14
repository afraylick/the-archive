import type WaveSurfer from 'wavesurfer.js';

/** The media clock is authoritative; cached/decoded duration is only a startup fallback. */
export const getPlayableDuration = (player: WaveSurfer, fallback = 0) => {
  for (const value of [player.getMediaElement().duration, player.getDuration(), fallback]) {
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
};

export const seekToProgress = (player: WaveSurfer, progress: number, fallback = 0) => {
  const safeProgress = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  const duration = getPlayableDuration(player, fallback);
  const time = duration * safeProgress;
  player.setTime(time);
  return { duration, progress: safeProgress, time };
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
