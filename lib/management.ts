import { WAVEFORM_CACHE_VERSION } from './waveform';

export interface ManagedRecording {
  id: string;
  name: string;
  originalName?: string;
  defaultVersionId?: string;
  instruments?: string[];
  instrument?: string;
  vibes?: string[];
  vibe?: string;
  finish?: string;
  year?: number;
  collections?: string[];
  uploads?: ManagedRecording[];
  waveformAvailable?: boolean;
  waveformCacheVersion?: number;
  waveformDuration?: number;
  stems?: { id: string; name: string };
  notes?: string;
  uploadedAt?: string;
  uploadedByName?: string;
}

export const allManagedRecordings = (projects: ManagedRecording[]) => projects.flatMap(project => [project, ...(project.uploads || [])]);
export const defaultRecording = (project: ManagedRecording) => project.uploads?.find(version => version.id === project.defaultVersionId) || project;
export const hasManagedWaveform = (recording: ManagedRecording) => Boolean(recording.waveformAvailable && recording.waveformCacheVersion === WAVEFORM_CACHE_VERSION);
export const recordingTags = (recording: ManagedRecording, kind: 'instruments' | 'vibes') => recording[kind] || [kind === 'instruments' ? recording.instrument || '' : recording.vibe || ''].filter(Boolean);

export function replaceManagedRecording(projects: ManagedRecording[], id: string, changes: Partial<ManagedRecording>) {
  return projects.map(project => project.id === id ? { ...project, ...changes } : {
    ...project,
    uploads: project.uploads?.map(version => version.id === id ? { ...version, ...changes } : version),
  });
}

export function collectionNames(projects: ManagedRecording[]) {
  return Array.from(new Set(allManagedRecordings(projects).flatMap(recording => recording.collections || []))).sort((a, b) => a.localeCompare(b));
}

export const projectInCollection = (project: ManagedRecording, collection: string) => [project, ...(project.uploads || [])].some(recording => recording.collections?.includes(collection));

export function renameManagedCollection(projects: ManagedRecording[], previous: string, name: string) {
  const rename = (recording: ManagedRecording) => ({
    ...recording,
    collections: Array.from(new Set((recording.collections || []).map(value => value === previous ? name : value))),
  });
  return projects.map(project => ({ ...rename(project), uploads: project.uploads?.map(rename) }));
}

export function metadataEdits(before: ManagedRecording, after: ManagedRecording) {
  const changes: import('./recording-mutations').MetadataChanges = {};
  for (const key of ['name', 'notes', 'finish', 'year', 'defaultVersionId'] as const) {
    if (after[key] !== undefined && after[key] !== before[key]) Object.assign(changes, { [key]: after[key] });
  }
  for (const key of ['instruments', 'vibes'] as const) {
    if (JSON.stringify(recordingTags(before, key)) !== JSON.stringify(recordingTags(after, key))) changes[key] = recordingTags(after, key);
  }
  return changes;
}
