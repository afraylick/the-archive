'use client';

import { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { useWaveform } from '@/lib/use-waveform';
import { isValidWaveformCache } from '@/lib/waveform';
import { getPlayableDuration, getPlaybackAudioUrl } from '@/lib/playback';
import s from './management.module.css';

const formatTime = (seconds: number) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;

export default function RecordingPlayer({ recordingId }: { recordingId: string }) {
  const container = useRef<HTMLDivElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const player = useRef<WaveSurfer | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const cached = useWaveform(recordingId, true, attempt);
  const hasCache = isValidWaveformCache(cached.data.waveformPeaks, cached.data.waveformDuration, cached.data.waveformCacheVersion);

  useEffect(() => {
    if (!cached.ready || !container.current || !audio.current) return;
    const media = audio.current;
    let disposed = false;
    const waveform = WaveSurfer.create({
      container: container.current,
      media,
      height: 110,
      waveColor: '#727479',
      progressColor: '#3680e9',
      cursorColor: '#3680e9',
      cursorWidth: 1,
      backend: 'MediaElement',
      interact: true,
      dragToSeek: { debounceTime: 30 },
    });
    player.current = waveform;
    waveform.setVolume(0.5);
    const syncDuration = () => {
      const total = getPlayableDuration(waveform, hasCache ? cached.data.waveformDuration : 0);
      if (total > 0.001) { setDuration(total); setReady(true); }
    };
    waveform.on('ready', syncDuration);
    waveform.on('play', () => setPlaying(true));
    waveform.on('pause', () => setPlaying(false));
    waveform.on('finish', () => setPlaying(false));
    waveform.on('timeupdate', setTime);
    waveform.on('seeking', setTime);
    const fail = () => { if (!disposed) { setError('Audio unavailable.'); setReady(false); setPlaying(false); } };
    waveform.on('error', fail);
    media.addEventListener('loadedmetadata', syncDuration);
    media.addEventListener('durationchange', syncDuration);
    media.addEventListener('archiveplaybackerror', fail);
    // The same stored peaks and stream as the library. Supplying peaks (even a
    // flat fallback) prevents WaveSurfer from downloading/decoding audio again.
    void waveform.load(
      getPlaybackAudioUrl(recordingId),
      hasCache ? cached.data.waveformPeaks : [[0, 0]],
      hasCache ? cached.data.waveformDuration : 0.001,
    ).catch(fail);
    return () => {
      disposed = true;
      media.removeEventListener('loadedmetadata', syncDuration);
      media.removeEventListener('durationchange', syncDuration);
      media.removeEventListener('archiveplaybackerror', fail);
      media.pause();
      waveform.destroy();
      media.removeAttribute('src');
      media.load();
      player.current = null;
    };
  }, [recordingId, cached.ready, cached.data, hasCache]);

  function seek(seconds: number) {
    const next = Math.max(0, Math.min(duration, seconds));
    player.current?.setTime(next);
    setTime(next);
  }

  return <div className={s.player}>
    <audio ref={audio} preload="metadata"/>
    <div className={s.playerLabel}><span>{cached.ready ? hasCache ? 'Waveform' : 'No cached waveform' : 'Loading waveform…'}</span><span>{error || (ready ? '' : 'Loading audio…')}</span></div>
    <div ref={container} className={s.playerWave} aria-label="Audio waveform"/>
    <input className={s.seek} type="range" min="0" max={duration || 1} step="0.01" value={time} disabled={!ready}
      aria-label="Seek recording" aria-valuetext={`${formatTime(time)} of ${formatTime(duration)}`}
      onChange={event => seek(Number(event.target.value))}
      onKeyDown={event => {
        if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          seek(event.key === 'Home' ? 0 : duration);
        }
      }}/>
    <div className={s.playerControls}>
      <button type="button" className={s.transport} disabled={!ready} aria-label="Back 10 seconds" onClick={() => seek((player.current?.getCurrentTime() || 0) - 10)}>−10s</button>
      <button type="button" className={s.playButton} disabled={!ready} aria-label={playing ? 'Pause recording' : 'Play recording'}
        onClick={() => { const waveform = player.current; if (!waveform) return; if (waveform.getCurrentTime() >= waveform.getDuration()) waveform.setTime(0); void waveform.playPause().catch(() => setError('Playback failed.')); }}>
        <svg viewBox="0 0 20 20" aria-hidden="true">{playing ? <path d="M5 4h3v12H5zm7 0h3v12h-3z"/> : <path d="M6 3v14l11-7z"/>}</svg>
      </button>
      <button type="button" className={s.transport} disabled={!ready} aria-label="Forward 10 seconds" onClick={() => seek((player.current?.getCurrentTime() || 0) + 10)}>+10s</button>
      <output className={s.playerTime} aria-label="Playback time">{formatTime(time)} <span>/ {formatTime(duration)}</span></output>
      {error && <button type="button" className={s.secondary} onClick={() => { setError(''); setReady(false); setTime(0); setDuration(0); setPlaying(false); setAttempt(value => value + 1); }}>Retry</button>}
    </div>
  </div>;
}
