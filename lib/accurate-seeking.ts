import type WaveSurfer from 'wavesurfer.js';
import { DecodedMedia } from './decoded-media';

type Session = { player: WaveSurfer; original: HTMLMediaElement; controller: AbortController; context: AudioContext; media?: DecodedMedia; ready: Promise<void>; cleanup: () => void };
let session: Session | null = null;

/** Only the actively scrubbed Firefox MP3 is decoded. Switching tracks frees it. */
export const releaseAccurateSeeking = (except?: WaveSurfer) => {
  if (!session || session.player === except) return;
  session.cleanup();
};

export const cancelAccuratePreparation = (player: WaveSurfer) => {
  if (session?.player === player && !session.media) session.cleanup();
};

export const prepareAccurateSeeking = async (player: WaveSurfer) => {
  if (session?.player === player) return session.ready;
  const original = player.getMediaElement();
  if (typeof navigator === 'undefined' || !/Firefox\//.test(navigator.userAgent) || !/\.mp3(?:\/audio)?(?:\?|$)/i.test(original.currentSrc || original.src)) return;
  releaseAccurateSeeking();
  const controller = new AbortController();
  const context = new AudioContext();
  // Resume during the click gesture, before awaiting network/decode work.
  const resumed = context.resume();
  const current: Session = { player, original, controller, context, ready: Promise.resolve(), cleanup: () => {
    if (session !== current) return;
    session = null;
    controller.abort();
    player.un('destroy', current.cleanup);
    if (current.media) {
      const time = current.media.currentTime;
      current.media.pause();
      player.setMediaElement(original);
      original.currentTime = time;
      current.media.destroy();
    } else void context.close().catch(() => undefined);
  } };
  session = current;
  player.on('destroy', current.cleanup);
  current.ready = (async () => {
    try {
      await resumed;
      const response = await fetch(original.currentSrc || original.src, { signal: controller.signal });
      if (!response.ok) throw new Error(`Audio download failed (${response.status})`);
      const buffer = await context.decodeAudioData(await response.arrayBuffer());
      if (session !== current || controller.signal.aborted) throw new DOMException('Seek cancelled', 'AbortError');
      const media = new DecodedMedia(context, buffer, original.currentSrc || original.src);
      media.addEventListener('archiveplaybackerror', () => original.dispatchEvent(new Event('archiveplaybackerror')));
      media.volume = player.getVolume();
      media.playbackRate = player.getPlaybackRate();
      current.media = media;
      original.pause();
      player.setMediaElement(media as unknown as HTMLMediaElement);
    } catch (error) {
      current.cleanup();
      throw error;
    }
  })();
  return current.ready;
};
