'use client';

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { isValidWaveformCache, roundWaveformPeak, WAVEFORM_CACHE_VERSION, WAVEFORM_PEAK_LENGTH } from '@/lib/waveform';
import { getCreatedAtWithYear } from '@/lib/recorded-date';

interface AudioFile {
  id: string;
  projectId?: string;
  defaultVersionId?: string;
  uploadedBy?: string;
  uploadedByName?: string;
  uploads?: AudioFile[];
  name: string;
  originalName?: string;
  instrument?: string;
  vibe?: string;
  instruments?: string[];
  vibes?: string[];
  finish?: string;
  collections?: string[];
  colorTags?: string[];
  waveformPeaks?: number[][];
  waveformDuration?: number;
  waveformCacheVersion?: number;
  year?: number;
  createdAt?: string;
  ratings?: Record<string, number>;
  likedBy?: string[];
  stems?: StemAttachment;
  myRating: number;
  userRating: number;
  notes?: string;
  comments: {
    id?: string;
    text: string;
    timestamp?: number;
    userId?: string;
    userName?: string;
    createdAt?: string;
  }[];
  uploadedAt: string;
}

interface StemAttachment {
  id: string;
  name: string;
  uploadedAt: string;
}

interface WaveformGenerationResponse {
  waveformPeaks: number[][];
  waveformDuration: number;
  waveformCacheVersion: number;
}

interface ArchiveUser {
  id: string;
  name: string;
  isAdmin: boolean;
}

const FINISH_OPTIONS = ['Tracked', 'Recorder', 'Voice Memo'];
const FINDER_COLOR_HEX: Record<string, string> = {
  gray: '#8e8e93',
  green: '#34c759',
  purple: '#af52de',
  blue: '#0a84ff',
  yellow: '#ffd60a',
  red: '#ff453a',
  orange: '#ff9f0a',
};
const TAG_LABELS: Record<string, string> = {
  'electric guitar': 'E. Guitar',
  'e. guitar': 'E. Guitar',
  'acoustic guitar': 'Acoustic',
};

const displayTag = (tag: string) => TAG_LABELS[tag.toLowerCase()] || tag.replace(/\b\w/g, char => char.toUpperCase());
const normalizeTag = (tag: string) => TAG_LABELS[tag.toLowerCase()] || tag;
const formatCsvDate = (value: string | undefined) => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
};

const formatShortDate = (value: string | undefined) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: '2-digit',
  }).format(date);
};

const csvCell = (value: unknown) => {
  const text = value === undefined || value === null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
};

let waveformAudioContext: AudioContext | null = null;

const getWaveformAudioContext = () => {
  waveformAudioContext ??= new AudioContext();
  return waveformAudioContext;
};

const getTags = (file: AudioFile, pluralKey: 'instruments' | 'vibes', singularKey: 'instrument' | 'vibe') => {
  const tags = file[pluralKey];
  if (Array.isArray(tags) && tags.length > 0) return tags.filter(Boolean).map(normalizeTag);
  const tag = file[singularKey];
  return tag ? [normalizeTag(tag)] : [];
};

const getAllManagedFiles = (projects: AudioFile[]) => projects.flatMap(project => [project, ...(project.uploads || [])]);

const findManagedFile = (projects: AudioFile[], id: string) => (
  getAllManagedFiles(projects).find(file => file.id === id)
);

const replaceManagedFile = (projects: AudioFile[], updatedFile: AudioFile) => projects.map(project => {
  if (project.id === updatedFile.id) {
    return { ...updatedFile, uploads: project.uploads };
  }
  if (!project.uploads?.some(upload => upload.id === updatedFile.id)) return project;
  return {
    ...project,
    uploads: project.uploads.map(upload => upload.id === updatedFile.id ? updatedFile : upload),
  };
});

const removeManagedFile = (projects: AudioFile[], id: string) => projects
  .filter(project => project.id !== id)
  .map(project => ({
    ...project,
    defaultVersionId: project.defaultVersionId === id ? project.id : project.defaultVersionId,
    uploads: project.uploads?.filter(upload => upload.id !== id),
  }));

const mapManagedFiles = (projects: AudioFile[], mapper: (file: AudioFile) => AudioFile) => projects.map(project => ({
  ...mapper(project),
  uploads: project.uploads?.map(mapper),
}));

const hasCachedWaveform = (file: AudioFile) => isValidWaveformCache(file.waveformPeaks, file.waveformDuration, file.waveformCacheVersion);

const createWaveformPeaks = (audioBuffer: AudioBuffer) => {
  const peaks: number[] = [];
  const samplesPerPeak = audioBuffer.length / WAVEFORM_PEAK_LENGTH;

  for (let i = 0; i < WAVEFORM_PEAK_LENGTH; i++) {
    const start = Math.floor(i * samplesPerPeak);
    const end = Math.max(start + 1, Math.ceil((i + 1) * samplesPerPeak));
    let peak = 0;

    for (let sampleIndex = start; sampleIndex < end && sampleIndex < audioBuffer.length; sampleIndex++) {
      for (let channelIndex = 0; channelIndex < audioBuffer.numberOfChannels; channelIndex++) {
        const sample = audioBuffer.getChannelData(channelIndex)[sampleIndex] || 0;
        if (Math.abs(sample) > Math.abs(peak)) {
          peak = sample;
        }
      }
    }

    peaks.push(roundWaveformPeak(peak));
  }

  return [peaks];
};

const getRatingColor = (rating: number) => {
  const colors = {
    1: 'text-yellow-500',
    2: 'text-lime-500',
    3: 'text-green-500',
    4: 'text-teal-500',
    5: 'text-blue-500',
  };
  return colors[rating as keyof typeof colors] || 'text-yellow-400';
};

const StarIcon = ({ filled }: { filled: boolean }) => (
  <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M12 3.5l2.58 5.23 5.77.84-4.18 4.07.99 5.75L12 16.68l-5.16 2.71.99-5.75-4.18-4.07 5.77-.84L12 3.5z"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
    />
  </svg>
);

const RatingInput = ({ value, onChange }: { value: number; onChange: (rating: number) => void }) => {
  const [hoveredRating, setHoveredRating] = useState(0);
  const displayedRating = hoveredRating || value;

  return (
    <div className="flex items-center">
      {[1, 2, 3, 4, 5].map(star => (
        <button
          key={star}
          type="button"
          onClick={() => onChange(star)}
          onMouseEnter={() => setHoveredRating(star)}
          onMouseLeave={() => setHoveredRating(0)}
          className={`inline-flex h-6 w-5 items-center justify-center ${star <= displayedRating ? getRatingColor(displayedRating) : 'text-muted-foreground'}`}
        >
          <StarIcon filled={star <= displayedRating} />
        </button>
      ))}
    </div>
  );
};

const ManageWaveform = ({
  file,
  activeWaveSurferRef,
  onWaveformRegenerated,
}: {
  file: AudioFile;
  activeWaveSurferRef: MutableRefObject<WaveSurfer | null>;
  onWaveformRegenerated: (file: AudioFile, waveformPeaks: number[][], waveformDuration: number) => Promise<void>;
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [hasPreview, setHasPreview] = useState(false);
  const [status, setStatus] = useState('Click waveform to load full song and refresh cache');
  const latestFileRef = useRef(file);

  useEffect(() => {
    latestFileRef.current = file;
  }, [file]);

  useEffect(() => {
    return () => {
      if (activeWaveSurferRef.current === wavesurferRef.current) {
        activeWaveSurferRef.current = null;
      }
      wavesurferRef.current?.destroy();
      wavesurferRef.current = null;
    };
  }, [activeWaveSurferRef]);

  const togglePlayer = async () => {
    if (wavesurferRef.current) {
      if (activeWaveSurferRef.current && activeWaveSurferRef.current !== wavesurferRef.current) {
        activeWaveSurferRef.current.pause();
      }
      activeWaveSurferRef.current = wavesurferRef.current;
      wavesurferRef.current.playPause();
      return;
    }

    if (!containerRef.current) return;

    setStatus('Loading full song...');
    const cachedWaveform = hasCachedWaveform(latestFileRef.current);
    const wavesurfer = WaveSurfer.create({
      container: containerRef.current,
      waveColor: '#a3a3a3',
      progressColor: '#5e9ec5',
      height: 116,
      interact: true,
      dragToSeek: true,
      backend: cachedWaveform ? 'MediaElement' : 'WebAudio',
      url: `/api/files/${encodeURIComponent(file.id)}/audio`,
      peaks: cachedWaveform ? latestFileRef.current.waveformPeaks : undefined,
      duration: cachedWaveform ? latestFileRef.current.waveformDuration : undefined,
    });

    wavesurferRef.current = wavesurfer;
    setHasPreview(true);

    wavesurfer.on('ready', () => {
      setStatus('Playing');
      if (activeWaveSurferRef.current && activeWaveSurferRef.current !== wavesurfer) {
        activeWaveSurferRef.current.pause();
      }
      activeWaveSurferRef.current = wavesurfer;
      wavesurfer.play();
    });

    wavesurfer.on('play', () => {
      setIsPlaying(true);
      setStatus('Playing');
    });

    wavesurfer.on('pause', () => {
      setIsPlaying(false);
      setStatus('Ready');
    });

    wavesurfer.on('finish', () => {
      setIsPlaying(false);
      setStatus('Ready');
    });

    wavesurfer.on('decode', async (duration: number) => {
      try {
        setStatus('Refreshing waveform...');
        const decodedData = wavesurfer.getDecodedData();
        if (!decodedData) return;

        const waveformPeaks = createWaveformPeaks(decodedData);
        if (!waveformPeaks[0]?.length || duration <= 0) return;

        await onWaveformRegenerated(latestFileRef.current, waveformPeaks, duration);
        setStatus(wavesurfer.isPlaying() ? 'Playing' : 'Ready');
      } catch (error) {
        console.error('Failed to refresh manage waveform for', latestFileRef.current.id, error);
        setStatus('Player loaded, waveform refresh failed');
      }
    });

    wavesurfer.on('error', (error: Error) => {
      console.error('Manage WaveSurfer error for', file.id, error);
      setStatus('Preview failed');
    });
  };

  return (
    <div className="mt-3 w-full">
      <div
        className="relative min-h-32 overflow-hidden rounded border border-border/60 bg-background/60 p-2 transition hover:border-accent/50"
      >
        <div ref={containerRef} className="min-h-28 w-full" />
        {!hasPreview && (
          <button
            type="button"
            onClick={togglePlayer}
            className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground transition hover:text-foreground"
          >
            Click to load full song
          </button>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{status}</span>
        {hasPreview && (
          <button
            type="button"
            onClick={togglePlayer}
            className="rounded border border-border px-2 py-1 transition hover:border-accent hover:text-foreground"
          >
            {isPlaying ? 'Pause' : 'Play'}
          </button>
        )}
      </div>
    </div>
  );
};

export default function ManagePage() {
  const [files, setFiles] = useState<AudioFile[]>([]);
  const [accountUsers, setAccountUsers] = useState<ArchiveUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [waveformProcessingId, setWaveformProcessingId] = useState<string | null>(null);
  const [waveformBulkStatus, setWaveformBulkStatus] = useState('');
  const [stemUploadingId, setStemUploadingId] = useState<string | null>(null);
  const [stemDeletingId, setStemDeletingId] = useState<string | null>(null);
  const [finderTagImporting, setFinderTagImporting] = useState(false);
  const [finderTagImportStatus, setFinderTagImportStatus] = useState('');
  const [selectedCollection, setSelectedCollection] = useState('');
  const [collectionName, setCollectionName] = useState('');
  const [collectionStatus, setCollectionStatus] = useState('');
  const [collectionBusy, setCollectionBusy] = useState(false);
  const activeWaveSurferRef = useRef<WaveSurfer | null>(null);
  const adminName = accountUsers.find(user => user.id === 'adam')?.name || 'Admin';
  const accountNamesById = new Map(accountUsers.map(user => [user.id, user.name]));

  const fetchFiles = useCallback(() => {
    fetch('/api/files')
      .then(res => res.json())
      .then(data => {
        setFiles(data);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    fetch('/api/session')
      .then(res => res.json())
      .then((data: { users: ArchiveUser[] }) => setAccountUsers(data.users));
    fetchFiles();
  }, [fetchFiles]);

  const deleteFile = async (id: string) => {
    const target = findManagedFile(files, id);
    const isVariation = Boolean(target?.projectId);
    const label = target?.originalName || target?.name || 'this file';
    if (!confirm(isVariation
      ? `Delete the variation "${label}"? The main song will not be deleted.`
      : `Delete the song project "${label}" and all of its variations?`
    )) return;
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res.ok) {
        setFiles(prev => removeManagedFile(prev, id));
      } else {
        alert('Failed to delete');
      }
    } catch {
      alert('Error deleting file');
    }
  };

  const resetFriendRatings = async (id: string) => {
    try {
      const file = findManagedFile(files, id);
      if (!file) return;
      const updatedFile = {
        ...file,
        userRating: 0,
        ratings: { adam: file.ratings?.adam || file.myRating || 0 },
      };
      const res = await fetch(`/api/files/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedFile),
      });
      if (res.ok) {
        setFiles(prev => replaceManagedFile(prev, updatedFile));
      } else {
        alert('Failed to reset ratings');
      }
    } catch {
      alert('Error resetting ratings');
    }
  };

  const saveFile = async (updatedFile: AudioFile, errorMessage: string) => {
    const persistedFile = { ...updatedFile };
    delete persistedFile.uploads;
    const res = await fetch(`/api/files/${encodeURIComponent(updatedFile.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(persistedFile),
    });

    if (!res.ok) {
      throw new Error(errorMessage);
    }

    setFiles(prev => replaceManagedFile(prev, updatedFile));
  };

  const refreshWaveformFromPreview = async (file: AudioFile, waveformPeaks: number[][], waveformDuration: number) => {
    await saveFile(
      {
        ...file,
        waveformPeaks,
        waveformDuration,
        waveformCacheVersion: WAVEFORM_CACHE_VERSION,
      },
      'Failed to save refreshed waveform'
    );
  };

  const cullWaveform = async (file: AudioFile) => {
    setWaveformProcessingId(file.id);
    try {
      await saveFile(
        { ...file, waveformPeaks: undefined, waveformDuration: undefined, waveformCacheVersion: undefined },
        'Failed to cull waveform'
      );
    } catch {
      alert('Failed to cull waveform');
    } finally {
      setWaveformProcessingId(null);
    }
  };

  const regenerateWaveform = async (file: AudioFile, showError = true) => {
    setWaveformProcessingId(file.id);
    try {
      const serverRes = await fetch(`/api/files/${encodeURIComponent(file.id)}/waveform`, {
        method: 'POST',
      });

      if (serverRes.ok) {
        const waveformData = await serverRes.json() as WaveformGenerationResponse;
        await saveFile(
          {
            ...file,
            waveformPeaks: waveformData.waveformPeaks,
            waveformDuration: waveformData.waveformDuration,
            waveformCacheVersion: waveformData.waveformCacheVersion,
          },
          'Failed to save waveform'
        );
        return;
      }

      const res = await fetch(`/api/files/${encodeURIComponent(file.id)}/audio`);
      if (!res.ok) throw new Error('Failed to load audio file');

      const audioContext = getWaveformAudioContext();
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      const audioBuffer = await audioContext.decodeAudioData(await res.arrayBuffer());
      await saveFile(
        {
          ...file,
          waveformPeaks: createWaveformPeaks(audioBuffer),
          waveformDuration: audioBuffer.duration,
          waveformCacheVersion: WAVEFORM_CACHE_VERSION,
        },
        'Failed to save waveform'
      );
    } catch (error) {
      console.error('Failed to regenerate waveform for', file.id, error);
      if (showError) alert('Failed to regenerate waveform');
    } finally {
      setWaveformProcessingId(null);
    }
  };

  const cullAllWaveforms = async () => {
    if (!confirm('Cull all cached waveforms? Audio files will not be deleted.')) return;
    const managedFiles = getAllManagedFiles(files);
    try {
      setWaveformBulkStatus(`Culled 0/${managedFiles.length}`);
      for (let i = 0; i < managedFiles.length; i++) {
        await saveFile(
          { ...managedFiles[i], waveformPeaks: undefined, waveformDuration: undefined, waveformCacheVersion: undefined },
          'Failed to cull waveform'
        );
        setWaveformBulkStatus(`Culled ${i + 1}/${managedFiles.length}`);
      }
    } catch {
      alert('Failed to cull all waveforms');
    } finally {
      setWaveformBulkStatus('');
    }
  };

  const regenerateAllWaveforms = async () => {
    const managedFiles = getAllManagedFiles(files);
    try {
      setWaveformBulkStatus(`Generated 0/${managedFiles.length}`);
      for (let i = 0; i < managedFiles.length; i++) {
        await regenerateWaveform(managedFiles[i], false);
        setWaveformBulkStatus(`Generated ${i + 1}/${managedFiles.length}`);
      }
    } finally {
      setWaveformBulkStatus('');
    }
  };

  const updateRating = async (id: string, userId: string, rating: number) => {
    try {
      const file = findManagedFile(files, id);
      if (!file) return;
      const res = await fetch(`/api/files/${encodeURIComponent(id)}/rating`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, rating }),
      });
      if (res.ok) {
        const ratingData = await res.json() as Pick<AudioFile, 'ratings' | 'myRating' | 'userRating'>;
        const updatedFile = { ...file, ...ratingData };
        setFiles(prev => replaceManagedFile(prev, updatedFile));
      } else {
        alert('Failed to update rating');
      }
    } catch {
      alert('Error updating rating');
    }
  };

  const updateFinish = async (file: AudioFile, finish: string) => {
    try {
      await saveFile({ ...file, finish: file.finish === finish ? '' : finish }, 'Failed to update finish');
    } catch {
      alert('Failed to update finish');
    }
  };

  const updateYear = async (file: AudioFile, value: string) => {
    const year = Number(value);
    if (!Number.isInteger(year) || year < 1900 || year > 2100) {
      alert('Enter a valid year');
      return;
    }

    if (file.year === year) return;

    try {
      await saveFile(
        {
          ...file,
          year,
          createdAt: getCreatedAtWithYear(file.createdAt, year),
        },
        'Failed to update year'
      );
    } catch {
      alert('Failed to update year');
    }
  };

  const uploadStems = async (file: AudioFile, zipFile: File | null) => {
    if (!zipFile) return;
    if (!zipFile.name.toLowerCase().endsWith('.zip')) {
      alert('Please choose a ZIP file');
      return;
    }

    setStemUploadingId(file.id);
    const formData = new FormData();
    formData.append('file', zipFile);

    try {
      const res = await fetch(`/api/files/${encodeURIComponent(file.id)}/stems`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(errorData?.error || 'Upload failed');
      }
      const data = await res.json() as { stems: StemAttachment };
      setFiles(prev => replaceManagedFile(prev, { ...file, stems: data.stems }));
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to upload stems ZIP');
    } finally {
      setStemUploadingId(null);
    }
  };

  const deleteStems = async (file: AudioFile) => {
    if (!file.stems) return;
    if (!confirm(`Delete stems ZIP for "${file.name}"?`)) return;

    setStemDeletingId(file.id);
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(file.id)}/stems`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(errorData?.error || 'Stem deletion failed');
      }
      setFiles(prev => replaceManagedFile(prev, { ...file, stems: undefined }));
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to delete stems ZIP');
    } finally {
      setStemDeletingId(null);
    }
  };

  const deleteAll = async () => {
    const confirmation = prompt('Type DELETE to permanently delete ALL files.');
    if (confirmation !== 'DELETE') return;
    try {
      const responses = await Promise.all(files.map(file => fetch(`/api/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' })));
      if (responses.some(res => !res.ok)) {
        throw new Error('Some files could not be deleted');
      }
      setFiles([]);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Error deleting files');
      fetchFiles(); // Refresh in case of partial failure
    }
  };

  const renameCollection = async () => {
    const name = collectionName.trim();
    if (!selectedCollection || !name || name === selectedCollection) return;

    setCollectionBusy(true);
    setCollectionStatus('');
    try {
      const res = await fetch('/api/collections', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: selectedCollection, name }),
      });
      const data = await res.json().catch(() => null) as { error?: string; filesUpdated?: number } | null;
      if (!res.ok) throw new Error(data?.error || 'Collection rename failed');

      setFiles(prev => mapManagedFiles(prev, file => ({
        ...file,
        collections: Array.from(new Set((file.collections || []).map(collection => collection === selectedCollection ? name : collection))),
      })));
      setSelectedCollection(name);
      setCollectionName('');
      setCollectionStatus(`Renamed on ${data?.filesUpdated || 0} song${data?.filesUpdated === 1 ? '' : 's'}.`);
    } catch (error) {
      setCollectionStatus(error instanceof Error ? error.message : 'Collection rename failed');
    } finally {
      setCollectionBusy(false);
    }
  };

  const deleteCollection = async () => {
    if (!selectedCollection) return;
    if (!confirm(`Delete the collection "${selectedCollection}"? Songs in it will not be deleted.`)) return;

    setCollectionBusy(true);
    setCollectionStatus('');
    try {
      const res = await fetch('/api/collections', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: selectedCollection }),
      });
      const data = await res.json().catch(() => null) as { error?: string; filesUpdated?: number } | null;
      if (!res.ok) throw new Error(data?.error || 'Collection deletion failed');

      setFiles(prev => mapManagedFiles(prev, file => ({
        ...file,
        collections: (file.collections || []).filter(collection => collection !== selectedCollection),
      })));
      setSelectedCollection('');
      setCollectionName('');
      setCollectionStatus(`Deleted from ${data?.filesUpdated || 0} song${data?.filesUpdated === 1 ? '' : 's'}.`);
    } catch (error) {
      setCollectionStatus(error instanceof Error ? error.message : 'Collection deletion failed');
    } finally {
      setCollectionBusy(false);
    }
  };

  const exportCsv = () => {
    const userIds = accountUsers.map(user => user.id);
    const userNamesById = new Map(accountUsers.map(user => [user.id, user.name]));
    const headers = [
      'name',
      'originalName',
      'notes',
      'likedBy',
      ...userIds.map(userId => `rating:${userNamesById.get(userId) || userId}`),
      'comments',
      'collections',
      'hasStems',
      'stemsName',
      'instruments',
      'vibes',
      'finish',
      'year',
      'recordedAt',
      'uploadedAt',
      'finderColorTags',
      'waveformCached',
      'waveformDuration',
      'id',
    ];

    const rows = getAllManagedFiles(files).map(file => {
      const comments = (file.comments || []).map(comment => {
        const userName = (comment.userId ? userNamesById.get(comment.userId) : '') || comment.userName || comment.userId || 'Unknown';
        const timecode = typeof comment.timestamp === 'number' ? ` @${comment.timestamp.toFixed(2)}s` : '';
        const createdAt = comment.createdAt ? ` (${formatCsvDate(comment.createdAt)})` : '';
        return `${userName}${timecode}${createdAt}: ${comment.text}`;
      }).join('\n');

      return [
        file.name,
        file.originalName || '',
        file.notes || '',
        (file.likedBy || []).map(userId => userNamesById.get(userId) || userId).join('; '),
        ...userIds.map(userId => file.ratings?.[userId] || ''),
        comments,
        (file.collections || []).join('; '),
        file.stems ? 'yes' : 'no',
        file.stems?.name || '',
        getTags(file, 'instruments', 'instrument').map(displayTag).join('; '),
        getTags(file, 'vibes', 'vibe').map(displayTag).join('; '),
        file.finish || '',
        file.year || '',
        formatCsvDate(file.createdAt),
        formatCsvDate(file.uploadedAt),
        (file.colorTags || []).join('; '),
        hasCachedWaveform(file) ? 'yes' : 'no',
        file.waveformDuration || '',
        file.id,
      ];
    });

    const csv = [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `the-archive-export-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const importFinderTags = async (metadataFile: File | null) => {
    if (!metadataFile) return;

    setFinderTagImporting(true);
    setFinderTagImportStatus('');
    const formData = new FormData();
    formData.append('file', metadataFile);

    try {
      const res = await fetch('/api/finder-tags/import', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json().catch(() => null) as {
        error?: string;
        matched?: number;
        updated?: number;
        ambiguous?: number;
        skipped?: number;
      } | null;
      if (!res.ok) {
        throw new Error(data?.error || 'Finder tag import failed');
      }

      setFinderTagImportStatus(
        `Finder tags updated: ${data?.updated || 0} matched, ${data?.skipped || 0} skipped, ${data?.ambiguous || 0} ambiguous`
      );
      fetchFiles();
    } catch (error) {
      setFinderTagImportStatus(error instanceof Error ? error.message : 'Finder tag import failed');
    } finally {
      setFinderTagImporting(false);
    }
  };

  const filteredFiles = files.filter(file => {
    const normalizedSearch = searchQuery.trim().toLowerCase();
    if (!normalizedSearch) return true;

    return [file, ...(file.uploads || [])].some(candidate => (
      candidate.name.toLowerCase().includes(normalizedSearch) ||
      (candidate.originalName || '').toLowerCase().includes(normalizedSearch) ||
      (candidate.notes || '').toLowerCase().includes(normalizedSearch) ||
      getTags(candidate, 'instruments', 'instrument').some(tag => tag.toLowerCase().includes(normalizedSearch)) ||
      getTags(candidate, 'vibes', 'vibe').some(tag => tag.toLowerCase().includes(normalizedSearch)) ||
      (candidate.finish || '').toLowerCase().includes(normalizedSearch) ||
      String(candidate.year || '').includes(normalizedSearch)
    ));
  });
  const collectionOptions = Array.from(new Set(getAllManagedFiles(files).flatMap(file => file.collections || []))).sort((a, b) => a.localeCompare(b));
  const waveformBulkProgress = waveformBulkStatus.match(/(\d+)\/(\d+)/);
  const waveformBulkDone = waveformBulkProgress ? Number(waveformBulkProgress[1]) : 0;
  const waveformBulkTotal = waveformBulkProgress ? Number(waveformBulkProgress[2]) : 0;
  const waveformBulkPercent = waveformBulkTotal > 0 ? Math.min(100, Math.max(0, (waveformBulkDone / waveformBulkTotal) * 100)) : 0;

  if (loading) return <div className="bg-background text-foreground min-h-screen flex items-center justify-center">Loading...</div>;

  return (
    <div className="bg-background text-foreground min-h-screen">
      <div className="container mx-auto p-4">
        <div className="mb-4 flex items-center gap-3">
          <button
            type="button"
            onClick={() => window.location.href = '/'}
            className="rounded border border-border px-3 py-2 text-sm text-muted-foreground transition hover:text-foreground"
          >
            Back
          </button>
          <h1 className="text-3xl font-bold">Manage Files</h1>
        </div>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <button
            onClick={deleteAll}
            className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 transition"
            disabled={files.length === 0}
          >
            Delete All Files
          </button>
          <button
            onClick={cullAllWaveforms}
            className="rounded bg-muted px-4 py-2 text-muted-foreground transition hover:bg-muted/80"
            disabled={files.length === 0 || Boolean(waveformBulkStatus)}
          >
            Cull All Waveforms
          </button>
          <button
            onClick={regenerateAllWaveforms}
            className="rounded bg-accent px-4 py-2 text-accent-foreground transition hover:bg-accent/80 disabled:opacity-50"
            disabled={files.length === 0 || Boolean(waveformBulkStatus)}
          >
            Regenerate All Waveforms
          </button>
          <button
            type="button"
            onClick={exportCsv}
            className="rounded border border-border px-4 py-2 text-sm text-muted-foreground transition hover:border-accent hover:text-foreground"
            disabled={files.length === 0}
          >
            Export CSV
          </button>
          <label className={`cursor-pointer rounded border border-border px-4 py-2 text-sm text-muted-foreground transition hover:border-accent hover:text-foreground ${
            finderTagImporting ? 'opacity-50' : ''
          }`}>
            {finderTagImporting ? 'Importing Finder Tags...' : 'Import Finder Tags'}
            <input
              type="file"
              accept="application/json,.json"
              className="hidden"
              disabled={finderTagImporting}
              onChange={(event) => {
                void importFinderTags(event.target.files?.[0] || null);
                event.currentTarget.value = '';
              }}
            />
          </label>
          {waveformBulkStatus && (
            <div className="flex min-w-44 items-center gap-2 text-sm text-muted-foreground">
              <span>{waveformBulkStatus}</span>
              <div className="h-1.5 min-w-20 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-200"
                  style={{ width: `${waveformBulkPercent}%` }}
                />
              </div>
            </div>
          )}
          {finderTagImportStatus && (
            <span className="text-sm text-muted-foreground">{finderTagImportStatus}</span>
          )}
        </div>
        <div className="mb-4 rounded border border-border bg-card p-4">
          <div className="mb-3">
            <h2 className="font-semibold">Manage Collections</h2>
            <p className="text-xs text-muted-foreground">Renaming or deleting a collection updates every song that uses it.</p>
          </div>
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <select
              value={selectedCollection}
              onChange={(event) => {
                setSelectedCollection(event.target.value);
                setCollectionName('');
                setCollectionStatus('');
              }}
              disabled={collectionOptions.length === 0 || collectionBusy}
              className="min-w-56 rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-accent disabled:opacity-50"
            >
              <option value="">{collectionOptions.length > 0 ? 'Choose a collection' : 'No collections yet'}</option>
              {collectionOptions.map(collection => <option key={collection} value={collection}>{displayTag(collection)}</option>)}
            </select>
            <input
              type="text"
              value={collectionName}
              onChange={(event) => setCollectionName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void renameCollection();
                }
              }}
              placeholder="New collection name"
              disabled={!selectedCollection || collectionBusy}
              className="min-w-0 flex-1 rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-accent disabled:opacity-50 md:max-w-sm"
            />
            <button
              type="button"
              onClick={() => void renameCollection()}
              disabled={!selectedCollection || !collectionName.trim() || collectionName.trim() === selectedCollection || collectionBusy}
              className="rounded bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition hover:bg-accent/80 disabled:opacity-50"
            >
              Rename
            </button>
            <button
              type="button"
              onClick={() => void deleteCollection()}
              disabled={!selectedCollection || collectionBusy}
              className="rounded bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-700 disabled:opacity-50"
            >
              Delete Collection
            </button>
          </div>
          {collectionStatus && <p className="mt-2 text-sm text-muted-foreground">{collectionStatus}</p>}
        </div>
        <div className="mb-4">
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search songs"
            className="w-full rounded border border-border bg-background p-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-accent md:max-w-md"
          />
        </div>
        <div className="space-y-4">
          {filteredFiles.map(file => (
            <div key={file.id} className="border border-border p-4 rounded-lg shadow-md bg-card">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <h2 className="break-words text-lg font-semibold sm:text-xl">{file.name}</h2>
                  {(file.uploads || []).length > 0 && (
                    <label className="my-2 block max-w-md">
                      <span className="mb-1 block text-xs font-medium text-muted-foreground">Default version when the page loads</span>
                      <select
                        value={file.defaultVersionId || file.id}
                        onChange={async (event) => {
                          try {
                            await saveFile({ ...file, defaultVersionId: event.target.value }, 'Failed to update default version');
                          } catch {
                            alert('Failed to update default version');
                          }
                        }}
                        className="w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
                      >
                        <option value={file.id}>Original recording</option>
                        {(file.uploads || []).map(variation => (
                          <option key={variation.id} value={variation.id}>
                            {variation.originalName || 'Uploaded variation'} · {(variation.uploadedBy ? accountNamesById.get(variation.uploadedBy) : '') || variation.uploadedByName || variation.uploadedBy || 'Unknown'}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <p className="text-muted-foreground">Instrument: {getTags(file, 'instruments', 'instrument').map(displayTag).join(', ') || 'None'}</p>
                  <p className="text-muted-foreground">Vibe: {getTags(file, 'vibes', 'vibe').map(displayTag).join(', ') || 'None'}</p>
                  <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                    <span>Finish:</span>
                    {FINISH_OPTIONS.map(option => (
                      <button
                        key={option}
                        type="button"
                        onClick={() => updateFinish(file, option)}
                        className={`rounded px-3 py-2 text-xs transition sm:px-2 sm:py-1 ${
                          file.finish === option
                            ? 'bg-accent text-accent-foreground'
                            : 'bg-muted text-muted-foreground hover:bg-muted/80'
                        }`}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                  <label className="flex max-w-40 items-center gap-2 text-muted-foreground">
                    <span>Year:</span>
                    <input
                      type="number"
                      min="1900"
                      max="2100"
                      defaultValue={file.year || ''}
                      onBlur={(event) => void updateYear(file, event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.currentTarget.blur();
                        }
                      }}
                      className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
                    />
                  </label>
                  {(file.colorTags || []).length > 0 && (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <span>Finder Tags:</span>
                      <div className="flex">
                        {(file.colorTags || []).filter(color => FINDER_COLOR_HEX[color]).map(color => (
                          <span
                            key={color}
                            className="-ml-1 first:ml-0 h-3.5 w-3.5 rounded-full border border-background"
                            style={{ backgroundColor: FINDER_COLOR_HEX[color] }}
                            title={color}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                  <p className="text-muted-foreground">
                    Waveform: {hasCachedWaveform(file) ? 'Cached' : 'Not cached'}
                  </p>
                  <p className="text-muted-foreground">
                    Stems: {file.stems ? file.stems.name : 'None'}
                  </p>
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <span>{adminName}&apos;s Rating:</span>
                    <RatingInput value={file.ratings?.adam || file.myRating} onChange={(rating) => updateRating(file.id, 'adam', rating)} />
                  </div>
                  <div className="mt-1 grid gap-1 text-muted-foreground sm:grid-cols-2">
                    {accountUsers.filter(user => user.id !== 'adam' && (file.ratings?.[user.id] || 0) > 0).map(user => (
                      <div key={user.id} className="flex items-center gap-2">
                        <span>{user.name}:</span>
                        <RatingInput value={file.ratings?.[user.id] || 0} onChange={(rating) => updateRating(file.id, user.id, rating)} />
                      </div>
                    ))}
                  </div>
                </div>
                <div className="w-full lg:max-w-xl lg:flex-1">
                  <div className="flex flex-wrap gap-2 lg:justify-end">
                    <label className="cursor-pointer rounded bg-muted px-3 py-2 text-sm text-muted-foreground transition hover:bg-muted/80">
                      {stemUploadingId === file.id ? 'Uploading...' : file.stems ? 'Replace Stems ZIP' : 'Upload Stems ZIP'}
                      <input
                        type="file"
                        accept=".zip,application/zip,application/x-zip-compressed"
                        className="hidden"
                        disabled={stemUploadingId === file.id}
                        onChange={(event) => uploadStems(file, event.target.files?.[0] || null)}
                      />
                    </label>
                    {file.stems && (
                      <button
                        type="button"
                        onClick={() => deleteStems(file)}
                        className="rounded bg-red-500 px-3 py-2 text-sm text-white hover:bg-red-600 disabled:opacity-50"
                        disabled={stemDeletingId === file.id}
                      >
                        {stemDeletingId === file.id ? 'Deleting Stems...' : 'Delete Stems'}
                      </button>
                    )}
                    <button
                      onClick={() => cullWaveform(file)}
                      className="rounded bg-muted px-3 py-2 text-sm text-muted-foreground hover:bg-muted/80 disabled:opacity-50"
                      disabled={waveformProcessingId === file.id || !hasCachedWaveform(file)}
                    >
                      Cull Waveform
                    </button>
                    <button
                      onClick={() => regenerateWaveform(file)}
                      className="rounded bg-accent px-3 py-2 text-sm text-accent-foreground hover:bg-accent/80 disabled:opacity-50"
                      disabled={waveformProcessingId === file.id}
                    >
                      {waveformProcessingId === file.id ? 'Working...' : 'Regenerate Waveform'}
                    </button>
                    <button
                      onClick={() => resetFriendRatings(file.id)}
                      className="rounded bg-yellow-500 px-3 py-2 text-sm text-white hover:bg-yellow-600"
                    >
                      Reset Friend Ratings
                    </button>
                    <button
                      onClick={() => deleteFile(file.id)}
                      className="rounded bg-red-500 px-3 py-2 text-sm text-white hover:bg-red-600"
                    >
                      Delete
                    </button>
                  </div>
                  <ManageWaveform
                    file={file}
                    activeWaveSurferRef={activeWaveSurferRef}
                    onWaveformRegenerated={refreshWaveformFromPreview}
                  />
                </div>
              </div>
              {(file.uploads || []).length > 0 && (
                <div className="mt-5 border-t border-border/70 pt-4">
                  <div className="mb-3 flex items-center gap-2">
                    <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-muted-foreground">Variations</h3>
                    <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent">{file.uploads?.length}</span>
                  </div>
                  <div className="space-y-3">
                    {(file.uploads || []).map(variation => (
                      <div key={variation.id} className="ml-0 rounded-md border border-border/70 bg-background/45 p-3 sm:ml-5 sm:p-4">
                        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                          <form
                            className="min-w-0 flex-1"
                            onSubmit={async (event) => {
                              event.preventDefault();
                              const formData = new FormData(event.currentTarget);
                              try {
                                await saveFile({
                                  ...variation,
                                  originalName: String(formData.get('originalName') || '').trim() || variation.originalName,
                                  notes: String(formData.get('notes') || ''),
                                }, 'Failed to save variation');
                              } catch {
                                alert('Failed to save variation');
                              }
                            }}
                          >
                            <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                              <h4 className="break-words font-semibold text-foreground">{variation.originalName || 'Uploaded variation'}</h4>
                              <span className="text-xs text-muted-foreground">
                                Uploaded by {(variation.uploadedBy ? accountNamesById.get(variation.uploadedBy) : '') || variation.uploadedByName || variation.uploadedBy || 'Unknown'}{formatShortDate(variation.uploadedAt) ? ` on ${formatShortDate(variation.uploadedAt)}` : ''}
                              </span>
                            </div>
                            <div className="grid gap-3 sm:grid-cols-2">
                              <label className="block">
                                <span className="mb-1 block text-xs font-medium text-muted-foreground">Variation file name</span>
                                <input
                                  name="originalName"
                                  type="text"
                                  defaultValue={variation.originalName || ''}
                                  maxLength={255}
                                  className="w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
                                />
                              </label>
                              <label className="block sm:row-span-2">
                                <span className="mb-1 block text-xs font-medium text-muted-foreground">Notes</span>
                                <textarea
                                  name="notes"
                                  defaultValue={variation.notes || ''}
                                  maxLength={10000}
                                  placeholder="Variation notes"
                                  className="min-h-24 w-full resize-y rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-accent"
                                />
                              </label>
                              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                                <span>Finish:</span>
                                {FINISH_OPTIONS.map(option => (
                                  <button
                                    key={option}
                                    type="button"
                                    onClick={() => updateFinish(variation, option)}
                                    className={`rounded px-2 py-1 text-xs transition ${
                                      variation.finish === option
                                        ? 'bg-accent text-accent-foreground'
                                        : 'bg-muted text-muted-foreground hover:bg-muted/80'
                                    }`}
                                  >
                                    {option}
                                  </button>
                                ))}
                              </div>
                              <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
                                <label className="flex max-w-40 items-center gap-2 text-sm text-muted-foreground">
                                  <span>Year:</span>
                                  <input
                                    type="number"
                                    min="1900"
                                    max="2100"
                                    defaultValue={variation.year || ''}
                                    onBlur={(event) => void updateYear(variation, event.currentTarget.value)}
                                    onKeyDown={(event) => {
                                      if (event.key === 'Enter') event.currentTarget.blur();
                                    }}
                                    className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
                                  />
                                </label>
                                <button type="submit" className="rounded bg-accent px-3 py-2 text-sm font-semibold text-accent-foreground transition hover:bg-accent/80">
                                  Save Changes
                                </button>
                              </div>
                            </div>
                          </form>
                          <div className="w-full lg:max-w-xl lg:flex-1">
                            <div className="flex flex-wrap gap-2 lg:justify-end">
                              <button
                                type="button"
                                onClick={() => cullWaveform(variation)}
                                className="rounded bg-muted px-3 py-2 text-sm text-muted-foreground hover:bg-muted/80 disabled:opacity-50"
                                disabled={waveformProcessingId === variation.id || !hasCachedWaveform(variation)}
                              >
                                Cull Waveform
                              </button>
                              <button
                                type="button"
                                onClick={() => regenerateWaveform(variation)}
                                className="rounded bg-accent px-3 py-2 text-sm text-accent-foreground hover:bg-accent/80 disabled:opacity-50"
                                disabled={waveformProcessingId === variation.id}
                              >
                                {waveformProcessingId === variation.id ? 'Working...' : 'Regenerate Waveform'}
                              </button>
                              <button
                                type="button"
                                onClick={() => resetFriendRatings(variation.id)}
                                className="rounded bg-yellow-500 px-3 py-2 text-sm text-white hover:bg-yellow-600"
                              >
                                Reset Friend Ratings
                              </button>
                              <button
                                type="button"
                                onClick={() => deleteFile(variation.id)}
                                className="rounded bg-red-500 px-3 py-2 text-sm text-white hover:bg-red-600"
                              >
                                Delete Variation
                              </button>
                            </div>
                            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted-foreground">
                              <span>Waveform: {hasCachedWaveform(variation) ? 'Cached' : 'Not cached'}</span>
                              <span className="flex items-center gap-2">
                                {adminName}&apos;s Rating:
                                <RatingInput value={variation.ratings?.adam || variation.myRating} onChange={(rating) => updateRating(variation.id, 'adam', rating)} />
                              </span>
                            </div>
                            <div className="mt-1 grid gap-1 text-sm text-muted-foreground sm:grid-cols-2">
                              {accountUsers.filter(user => user.id !== 'adam' && (variation.ratings?.[user.id] || 0) > 0).map(user => (
                                <div key={user.id} className="flex items-center gap-2">
                                  <span>{user.name}:</span>
                                  <RatingInput value={variation.ratings?.[user.id] || 0} onChange={(rating) => updateRating(variation.id, user.id, rating)} />
                                </div>
                              ))}
                            </div>
                            <ManageWaveform
                              file={variation}
                              activeWaveSurferRef={activeWaveSurferRef}
                              onWaveformRegenerated={refreshWaveformFromPreview}
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
