export interface MetadataChanges {
  name?: string;
  originalName?: string;
  notes?: string;
  finish?: string;
  instruments?: string[];
  vibes?: string[];
  year?: number;
  defaultVersionId?: string;
}

export type RecordingMutation =
  | { operation: 'metadata'; changes: MetadataChanges }
  | { operation: 'waveform'; waveform: { waveformPeaks: number[][]; waveformDuration: number; waveformCacheVersion: number } | null }
  | { operation: 'reset-member-ratings' };

/** Return only the committed fields; callers merge them into their latest state. */
export async function mutateRecording<T>(id: string, mutation: RecordingMutation): Promise<Partial<T>> {
  const response = await fetch(`/api/files/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mutation),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Update failed');
  const changes = body.changes as Record<string, unknown>;
  for (const key of ['waveformPeaks', 'waveformDuration', 'waveformCacheVersion']) {
    if (changes[key] === null) changes[key] = undefined;
  }
  return changes as Partial<T>;
}
