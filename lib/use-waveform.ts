'use client';
import { useEffect, useState } from 'react';
type Peaks = { waveformPeaks?: number[][]; waveformDuration?: number; waveformCacheVersion?: number };
/** Retain loaded peaks for this card; cancellation prevents stale version responses. */
export function useWaveform(id: string, enabled: boolean, revision = 0) {
  const [result, setResult] = useState<{ key: string; data: Peaks } | null>(null);
  const key = `${id}:${revision}`;
  useEffect(() => {
    if (!enabled || result?.key === key) return;
    const controller = new AbortController();
    fetch(`/api/files/${encodeURIComponent(id)}/waveform`, { signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error('Waveform unavailable'); return response.json(); })
      .then(data => { if (!controller.signal.aborted) setResult({ key, data }); })
      // A waveform failure must not prevent audio playback; refresh or remount retries.
      .catch(() => { if (!controller.signal.aborted) setResult({ key, data: {} }); });
    return () => controller.abort();
  }, [id, key, enabled, result?.key]);
  return { ready: result?.key === key, data: result?.key === key ? result.data : {} };
}
