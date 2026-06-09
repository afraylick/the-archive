export const WAVEFORM_PEAK_LENGTH = 4000;
export const WAVEFORM_PEAK_PRECISION = 10000;
export const WAVEFORM_CACHE_VERSION = 5;
export const WAVEFORM_GENERATION_SAMPLE_RATE = 8000;

export const hasLegacyLowPrecisionWaveform = (peaks: number[]) => {
  const sampleStep = Math.max(1, Math.floor(peaks.length / 200));
  const sampledPeaks = peaks
    .filter((_, index) => index % sampleStep === 0)
    .filter(peak => Math.abs(peak) > 0.001);

  if (sampledPeaks.length < 20) return false;

  const quarterStepPeaks = sampledPeaks.filter(peak => Math.abs(peak * 4 - Math.round(peak * 4)) < 0.00001);
  return quarterStepPeaks.length / sampledPeaks.length > 0.95;
};

export const isValidWaveformCache = (
  waveformPeaks: unknown,
  waveformDuration: unknown,
  waveformCacheVersion: unknown
) => {
  if (!Array.isArray(waveformPeaks) || waveformPeaks.length === 0) return false;
  const peaks = waveformPeaks[0];

  return Array.isArray(peaks) &&
    peaks.length >= 512 &&
    peaks.every(peak => typeof peak === 'number' && Number.isFinite(peak) && Math.abs(peak) <= 1) &&
    !hasLegacyLowPrecisionWaveform(peaks) &&
    typeof waveformDuration === 'number' &&
    Number.isFinite(waveformDuration) &&
    waveformDuration > 0 &&
    waveformCacheVersion === WAVEFORM_CACHE_VERSION;
};

export const roundWaveformPeak = (peak: number) => (
  Math.round(Math.min(1, Math.max(-1, peak)) * WAVEFORM_PEAK_PRECISION) / WAVEFORM_PEAK_PRECISION
);
