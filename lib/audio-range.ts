/** Ignore unsupported syntax; distinguish valid but unsatisfiable byte ranges. */
export const readAudioRange = (header: string | null, size: number): { start: number; end: number } | 'unsatisfiable' | null => {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const first = Number(match[1]);
  const last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || size === 0) return 'unsatisfiable';
  if (!match[1]) {
    if (last === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - last), end: size - 1 };
  }
  const end = match[2] ? Math.min(last, size - 1) : size - 1;
  return first >= size || end < first ? 'unsatisfiable' : { start: first, end };
};
