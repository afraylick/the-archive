'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Icon from '../manage/manage-icon';
import s from '../manage/management.module.css';
import u from './upload.module.css';
import { getCreatedAtWithYear, getRecordedDateFromFilename } from '@/lib/recorded-date';

const FINISH_OPTIONS = ['Tracked', 'Recorder', 'Voice Memo'];
const TAG_LABELS: Record<string, string> = {
  'electric guitar': 'E. Guitar',
  'e. guitar': 'E. Guitar',
  'acoustic guitar': 'Acoustic',
};
const FINDER_COLOR_HEX: Record<string, string> = {
  gray: '#8e8e93',
  green: '#34c759',
  purple: '#af52de',
  blue: '#0a84ff',
  yellow: '#ffd60a',
  red: '#ff453a',
  orange: '#ff9f0a',
};

const displayTag = (tag: string) => TAG_LABELS[tag.toLowerCase()] || tag.replace(/\b\w/g, char => char.toUpperCase());
const normalizeTag = (tag: string) => TAG_LABELS[tag.toLowerCase()] || tag;
const deriveFinishFromFilename = (filename: string) => filename.toLowerCase().includes('ste-0') ? 'Recorder' : 'Voice Memo';
const FINDER_COLOR_NAMES = new Set(Object.keys(FINDER_COLOR_HEX));
const TEMPORARY_WAVEFORM_BARS = 128;
const TEMPORARY_WAVEFORM_SAMPLES_PER_BAR = 48;
const MAX_TEMPORARY_WAVEFORM_JOBS = 2;
let temporaryWaveformAudioContext: AudioContext | null = null;
let activeTemporaryWaveformJobs = 0;
const temporaryWaveformQueue: Array<() => void> = [];

const deriveRatingFromColorTags = (colorTags: string[], fallbackRating: number) => {
  const colors = new Set(colorTags);
  if (colorTags.length > 3) return 5;
  if (colors.has('yellow') && colors.has('green')) return 2;
  if (colors.has('blue') && colors.has('green')) return 4;
  if (colors.has('blue')) return 5;
  if (colors.has('green')) return 3;
  if (colorTags.length === 1 && colors.has('yellow')) return 2;
  return fallbackRating;
};

interface FinderTagEntry {
  name?: string;
  fileName?: string;
  path?: string;
  relativePath?: string;
  colorTags?: string[];
}

interface FinderTagExport {
  files?: FinderTagEntry[];
}

const normalizeFilename = (value: string | undefined) => value ? value.split('/').pop()?.trim().toLowerCase() || '' : '';
const normalizeColorTags = (tags: unknown) => Array.isArray(tags)
  ? Array.from(new Set(tags
      .map(tag => String(tag).trim().toLowerCase())
      .filter(tag => FINDER_COLOR_NAMES.has(tag))
    ))
  : [];

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

const formatPreviewTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const wholeSeconds = Math.floor(seconds);
  return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, '0')}`;
};

const scheduleTemporaryWaveformJob = <T,>(job: () => Promise<T>) => new Promise<T>((resolve, reject) => {
  const run = () => {
    activeTemporaryWaveformJobs += 1;
    void job()
      .then(resolve, reject)
      .finally(() => {
        activeTemporaryWaveformJobs -= 1;
        temporaryWaveformQueue.shift()?.();
      });
  };

  if (activeTemporaryWaveformJobs < MAX_TEMPORARY_WAVEFORM_JOBS) run();
  else temporaryWaveformQueue.push(run);
});

const createTemporaryWaveformPeaks = (audioBuffer: AudioBuffer) => {
  const peaks = new Array<number>(TEMPORARY_WAVEFORM_BARS).fill(0);
  const samplesPerBar = audioBuffer.length / TEMPORARY_WAVEFORM_BARS;

  for (let barIndex = 0; barIndex < TEMPORARY_WAVEFORM_BARS; barIndex++) {
    const start = Math.floor(barIndex * samplesPerBar);
    const end = Math.min(audioBuffer.length, Math.max(start + 1, Math.floor((barIndex + 1) * samplesPerBar)));
    const stride = Math.max(1, Math.floor((end - start) / TEMPORARY_WAVEFORM_SAMPLES_PER_BAR));
    let peak = 0;

    for (let sampleIndex = start; sampleIndex < end; sampleIndex += stride) {
      for (let channelIndex = 0; channelIndex < audioBuffer.numberOfChannels; channelIndex++) {
        peak = Math.max(peak, Math.abs(audioBuffer.getChannelData(channelIndex)[sampleIndex] || 0));
      }
    }

    peaks[barIndex] = peak;
  }

  const maxPeak = Math.max(...peaks, 0.01);
  return peaks.map(peak => Math.max(0.04, peak / maxPeak));
};

interface AudioFile {
  instrument?: string;
  vibe?: string;
  instruments?: string[];
  vibes?: string[];
  collections?: string[];
  finish?: string;
}

const getTags = (file: AudioFile, pluralKey: 'instruments' | 'vibes', singularKey: 'instrument' | 'vibe') => {
  const tags = file[pluralKey];
  if (Array.isArray(tags) && tags.length > 0) return tags.filter(Boolean).map(normalizeTag);
  const tag = file[singularKey];
  return tag ? [normalizeTag(tag)] : [];
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
  <svg className={u.star} viewBox="0 0 24 24" aria-hidden="true">
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
    <div className={u.rating}>
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          aria-label={`Rate ${star} out of 5`}
          aria-pressed={value === star}
          onClick={() => onChange(star)}
          onMouseEnter={() => setHoveredRating(star)}
          onMouseLeave={() => setHoveredRating(0)}
          className={`${u.ratingStar} ${star <= displayedRating ? getRatingColor(displayedRating) : u.emptyStar}`}
        >
          <StarIcon filled={star <= displayedRating} />
        </button>
      ))}
      {value > 0 && <button type="button" className={u.clearRating} onClick={() => onChange(0)} aria-label="Clear rating"><Icon name="close" size={12}/></button>}
    </div>
  );
};

const TagPicker = ({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (tag: string) => void;
}) => (
  <fieldset className={u.tagPicker}>
    <legend>{label}</legend>
    <div className={u.tags}>
      {options.map(option => <button key={option} type="button" aria-pressed={selected.includes(option)} onClick={() => onToggle(option)} className={selected.includes(option) ? u.tagSelected : ''}>{displayTag(option)}</button>)}
      {options.length === 0 && <span className={u.noTags}>No tags yet</span>}
    </div>
  </fieldset>
);

const TemporaryWaveformPreview = ({
  source,
  src,
  name,
  onPlay,
}: {
  source: File | string;
  src: string;
  name: string;
  onPlay: (audio: HTMLAudioElement) => void;
}) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [waveformStatus, setWaveformStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    const audio = audioRef.current;
    return () => { audio?.pause(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    void scheduleTemporaryWaveformJob(async () => {
      if (cancelled) return;
      const arrayBuffer = source instanceof File
        ? await source.arrayBuffer()
        : await fetch(source, { signal: controller.signal }).then(response => {
            if (!response.ok) throw new Error('Preview load failed');
            return response.arrayBuffer();
          });
      if (cancelled) return;

      temporaryWaveformAudioContext ??= new AudioContext();
      const audioBuffer = await temporaryWaveformAudioContext.decodeAudioData(arrayBuffer);
      if (cancelled) return;

      setPeaks(createTemporaryWaveformPeaks(audioBuffer));
      setDuration(audioBuffer.duration);
      setWaveformStatus('ready');
    }).catch(error => {
      if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return;
      console.error('Temporary waveform generation failed for', name, error);
      setWaveformStatus('error');
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [name, source]);

  const waveformPath = useMemo(() => peaks.map((peak, index) => {
    const amplitude = Math.max(1, peak * 18);
    const x = index + 0.5;
    return `M${x} ${20 - amplitude}V${20 + amplitude}`;
  }).join(''), [peaks]);
  const progress = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;

  const playAudio = (audio: HTMLAudioElement) => {
    void audio.play().catch(() => setIsPlaying(false));
  };

  const playFromPosition = (event: React.MouseEvent<HTMLButtonElement>) => {
    const audio = audioRef.current;
    if (!audio) return;

    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / Math.max(1, bounds.width)));
    const audioDuration = audio.duration || duration;
    if (Number.isFinite(audioDuration) && audioDuration > 0) audio.currentTime = ratio * audioDuration;
    playAudio(audio);
  };

  const togglePlayback = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) playAudio(audio);
    else audio.pause();
  };

  return (
    <div className="min-w-0">
      <audio
        ref={audioRef}
        preload="metadata"
        src={src}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onPlay={(event) => {
          setIsPlaying(true);
          onPlay(event.currentTarget);
        }}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          setIsPlaying(false);
          setCurrentTime(0);
        }}
      />
      <div className="flex items-stretch overflow-hidden rounded border border-border bg-background/80">
        <button
          type="button"
          onClick={togglePlayback}
          className="inline-flex w-10 shrink-0 items-center justify-center border-r border-border text-muted-foreground transition hover:text-foreground"
          aria-label={`${isPlaying ? 'Pause' : 'Play'} ${name}`}
          title={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? (
            <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M5.5 4h3v12h-3zm6 0h3v12h-3z" />
            </svg>
          ) : (
            <svg className="ml-0.5 h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M6.5 3.5v13l10-6.5z" />
            </svg>
          )}
        </button>
        <button
          type="button"
          onClick={playFromPosition}
          className="relative h-14 min-w-0 flex-1 cursor-crosshair overflow-hidden"
          aria-label={`Seek in ${name}`}
          title="Click waveform to play from here"
        >
          {waveformStatus === 'ready' ? (
            <>
              <svg className="absolute inset-0 h-full w-full p-1.5 text-muted-foreground/55" viewBox={`0 0 ${TEMPORARY_WAVEFORM_BARS} 40`} preserveAspectRatio="none" aria-hidden="true">
                <path d={waveformPath} fill="none" stroke="currentColor" strokeWidth="0.7" />
              </svg>
              <svg
                className="absolute inset-0 h-full w-full p-1.5 text-accent"
                viewBox={`0 0 ${TEMPORARY_WAVEFORM_BARS} 40`}
                preserveAspectRatio="none"
                style={{ clipPath: `inset(0 ${100 - progress}% 0 0)` }}
                aria-hidden="true"
              >
                <path d={waveformPath} fill="none" stroke="currentColor" strokeWidth="0.7" />
              </svg>
            </>
          ) : (
            <span className="absolute inset-0 flex items-center justify-center px-2 text-xs text-muted-foreground">
              {waveformStatus === 'loading' ? 'Generating preview…' : 'Preview unavailable'}
            </span>
          )}
        </button>
        <span className="flex w-16 shrink-0 items-center justify-center border-l border-border px-1 text-[11px] text-muted-foreground">
          {formatPreviewTime(currentTime)} / {formatPreviewTime(duration)}
        </span>
      </div>
    </div>
  );
};

interface FileEntry {
  id: string;
  file: File;
  previewUrl: string;
  instruments: string[];
  vibes: string[];
  collections: string[];
  finish: string;
  notes: string;
  year: number;
  createdAt: string;
  colorTags: string[];
  rating: number;
}

export default function UploadPage() {
  const router = useRouter();
  const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [archiveName, setArchiveName] = useState('the archive');
  const [userName, setUserName] = useState('');
  const [queueSearch, setQueueSearch] = useState('');
  const [optionError, setOptionError] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadProgressKnown, setUploadProgressKnown] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');
  const [finderTagImportStatus, setFinderTagImportStatus] = useState('');
  const [finderTagFileName, setFinderTagFileName] = useState('');
  const [useFinderColorRating, setUseFinderColorRating] = useState(false);
  const [folderInstruments, setFolderInstruments] = useState<string[]>([]);
  const [folderVibes, setFolderVibes] = useState<string[]>([]);
  const [folderCollections, setFolderCollections] = useState<string[]>([]);
  const [folderFinish, setFolderFinish] = useState('');
  const [folderRating, setFolderRating] = useState(0);
  const [instrumentOptions, setInstrumentOptions] = useState<string[]>([]);
  const [vibeOptions, setVibeOptions] = useState<string[]>([]);
  const [collectionOptions, setCollectionOptions] = useState<string[]>([]);
  const [newInstrument, setNewInstrument] = useState('');
  const [newVibe, setNewVibe] = useState('');
  const [newCollection, setNewCollection] = useState('');
  const activeAudioRef = useRef<HTMLAudioElement | null>(null);
  const fileEntriesRef = useRef<FileEntry[]>([]);
  const nextEntryId = useRef(0);

  useEffect(() => {
    fileEntriesRef.current = fileEntries;
  }, [fileEntries]);

  useEffect(() => {
    return () => {
      fileEntriesRef.current.forEach(entry => URL.revokeObjectURL(entry.previewUrl));
    };
  }, []);

  useEffect(() => {
    fetch('/api/session')
      .then(res => res.json())
      .then((data: { user?: { name: string }; settings?: { archiveName?: string; defaultInstruments?: string[]; defaultVibes?: string[] } }) => {
        setArchiveName(data.settings?.archiveName || 'the archive');
        setUserName(data.user?.name || '');
        setInstrumentOptions(prev => Array.from(new Set([...prev, ...(data.settings?.defaultInstruments || [])])));
        setVibeOptions(prev => Array.from(new Set([...prev, ...(data.settings?.defaultVibes || [])])));
      }).catch(() => {});

    fetch('/api/files?view=metadata')
      .then(res => { if (!res.ok) throw new Error('Saved tags unavailable.'); return res.json(); })
      .then((files: AudioFile[]) => {
        setInstrumentOptions(prev => Array.from(new Set([...prev, ...files.flatMap(file => getTags(file, 'instruments', 'instrument'))])));
        setVibeOptions(prev => Array.from(new Set([...prev, ...files.flatMap(file => getTags(file, 'vibes', 'vibe'))])));
        setCollectionOptions(prev => Array.from(new Set([...prev, ...files.flatMap(file => Array.isArray(file.collections) ? file.collections.filter(Boolean) : [])])).sort((a, b) => a.localeCompare(b)));
      }).catch(() => setOptionError('Saved tags unavailable. You can add tags below.'));
  }, []);

  const createFileEntries = (files: File[]) => files.map(file => {
      const filenameRecordedDate = getRecordedDateFromFilename(file.name);
      const createdAt = filenameRecordedDate?.createdAt || new Date(file.lastModified).toISOString();

      return {
        id: String(nextEntryId.current++),
        file,
        previewUrl: URL.createObjectURL(file),
        instruments: folderInstruments,
        vibes: folderVibes,
        collections: folderCollections,
        finish: folderFinish || (filenameRecordedDate ? 'Tracked' : deriveFinishFromFilename(file.name)),
        notes: '',
        year: filenameRecordedDate?.year || new Date(createdAt).getFullYear(),
        createdAt,
        colorTags: [],
        rating: folderRating,
      };
    });

  const onDrop = (acceptedFiles: File[]) => {
    setUploadError('');
    const metadataFile = acceptedFiles.find(file => file.name.toLowerCase().endsWith('.json')) || null;
    const audioFiles = acceptedFiles.filter(file => !file.name.toLowerCase().endsWith('.json'));
    const newEntries = createFileEntries(audioFiles);

    if (metadataFile) {
      void applyFinderTagMetadata(metadataFile, newEntries);
    } else if (newEntries.length > 0) {
      setFileEntries(prev => [...prev, ...newEntries]);
    }
  };

  const { getRootProps, getInputProps, isDragActive, open: openFilePicker } = useDropzone({
    onDrop,
    accept: {
      'audio/*': ['.aac', '.aif', '.aiff', '.flac', '.m4a', '.mp3', '.ogg', '.wav'],
      'application/json': ['.json'],
    },
    multiple: true,
    noClick: true,
    noKeyboard: true,
    disabled: uploading,
    onDropRejected: rejected => setUploadError(`${rejected.length} unsupported file${rejected.length === 1 ? '' : 's'}. Choose an audio file.`),
  });

  const updateEntry = (index: number, field: keyof FileEntry, value: string[] | number | string | boolean) => {
    setFileEntries(prev => prev.map((entry, i) =>
      i === index ? { ...entry, [field]: value } : entry
    ));
  };

  const updateEntryYear = (index: number, value: string) => {
    const year = Number(value);
    if (!Number.isInteger(year) || year < 1900 || year > 2100) {
      alert('Enter a valid year');
      return;
    }

    setFileEntries(prev => prev.map((entry, i) => i === index
      ? { ...entry, year, createdAt: getCreatedAtWithYear(entry.createdAt, year) }
      : entry
    ));
  };

  const toggleEntryTag = (index: number, field: 'instruments' | 'vibes' | 'collections', tag: string) => {
    setFileEntries(prev => prev.map((entry, i) => {
      if (i !== index) return entry;
      const selectedTags = entry[field];
      return {
        ...entry,
        [field]: selectedTags.includes(tag)
          ? selectedTags.filter(selectedTag => selectedTag !== tag)
          : [...selectedTags, tag],
      };
    }));
  };

  const toggleFolderTag = (field: 'instruments' | 'vibes' | 'collections', tag: string) => {
    const setter = field === 'instruments'
      ? setFolderInstruments
      : field === 'vibes'
        ? setFolderVibes
        : setFolderCollections;
    const selectedTags = field === 'instruments'
      ? folderInstruments
      : field === 'vibes'
        ? folderVibes
        : folderCollections;
    const nextTags = selectedTags.includes(tag)
      ? selectedTags.filter(selectedTag => selectedTag !== tag)
      : [...selectedTags, tag];

    setter(nextTags);
    setFileEntries(prev => prev.map(entry => ({ ...entry, [field]: nextTags })));
  };

  const removeEntry = (index: number) => {
    setFileEntries(prev => {
      const entry = prev[index];
      if (entry) URL.revokeObjectURL(entry.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  };

  const applyFinderTagMetadata = async (metadataFile: File | null, additionalEntries: FileEntry[] = []) => {
    if (!metadataFile) return;
    setFinderTagFileName(metadataFile.name);

    try {
      const metadata = JSON.parse(await metadataFile.text()) as FinderTagExport;
      if (!Array.isArray(metadata.files)) {
        throw new Error('Invalid Finder tag JSON');
      }

      const tagsByName = new Map<string, string[]>();
      for (const entry of metadata.files) {
        const colorTags = normalizeColorTags(entry.colorTags);
        for (const name of [entry.name, entry.fileName, entry.relativePath, entry.path].map(normalizeFilename).filter(Boolean)) {
          tagsByName.set(name, colorTags);
        }
      }

      let matched = 0;
      setFileEntries(prev => [...prev, ...additionalEntries].map(entry => {
        const colorTags = tagsByName.get(normalizeFilename(entry.file.name));
        if (!colorTags) return entry;

        matched += 1;
        return {
          ...entry,
          colorTags,
          rating: useFinderColorRating ? deriveRatingFromColorTags(colorTags, entry.rating) : entry.rating,
        };
      }));

      setFinderTagImportStatus(`Applied Finder tags to ${matched} queued file${matched === 1 ? '' : 's'}.`);
    } catch (error) {
      if (additionalEntries.length > 0) {
        setFileEntries(prev => [...prev, ...additionalEntries]);
      }
      setFinderTagImportStatus(error instanceof Error ? error.message : 'Failed to apply Finder tags');
    }
  };

  const addInstrument = () => {
    const tag = newInstrument.trim();
    if (tag && !instrumentOptions.includes(tag)) {
      setInstrumentOptions([...instrumentOptions, tag]);
      setNewInstrument('');
    }
  };

  const toggleFolderFinish = (finish: string) => {
    const nextFinish = folderFinish === finish ? '' : finish;
    setFolderFinish(nextFinish);
    setFileEntries(prev => prev.map(entry => ({ ...entry, finish: nextFinish })));
  };

  const updateFolderRating = (rating: number) => {
    setFolderRating(rating);
    setFileEntries(prev => prev.map(entry => ({
      ...entry,
      rating: useFinderColorRating ? deriveRatingFromColorTags(entry.colorTags, rating) : rating,
    })));
  };

  const addVibe = () => {
    const tag = newVibe.trim();
    if (tag && !vibeOptions.includes(tag)) {
      setVibeOptions([...vibeOptions, tag]);
      setNewVibe('');
    }
  };

  const addCollection = () => {
    const tag = newCollection.trim();
    if (tag && !collectionOptions.includes(tag)) {
      setCollectionOptions([...collectionOptions, tag].sort((a, b) => a.localeCompare(b)));
      setNewCollection('');
    }
  };

  const handlePreviewPlay = (audio: HTMLAudioElement) => {
    if (activeAudioRef.current && activeAudioRef.current !== audio) {
      activeAudioRef.current.pause();
    }
    activeAudioRef.current = audio;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (fileEntries.length === 0 || uploading) return;

    setUploading(true);
    setUploadError('');
    setUploadProgress(0);
    setUploadProgressKnown(false);
    setUploadStatus('Preparing upload…');
    const formData = new FormData();
    fileEntries.forEach((entry, index) => {
      formData.append('files', entry.file);
      formData.append(`metadata[${index}]`, JSON.stringify({
        instruments: entry.instruments,
        vibes: entry.vibes,
        collections: entry.collections,
        finish: entry.finish,
        notes: entry.notes,
        year: entry.year,
        createdAt: entry.createdAt,
        colorTags: entry.colorTags,
        rating: entry.rating,
      }));
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload');

        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable && event.total > 0) {
            const nextProgress = Math.min(99, Math.round((event.loaded / event.total) * 100));
            setUploadProgressKnown(true);
            setUploadProgress(nextProgress);
            setUploadStatus(`Uploading ${formatBytes(event.loaded)} of ${formatBytes(event.total)}`);
          } else {
            setUploadProgressKnown(false);
            setUploadStatus(`Uploading ${formatBytes(event.loaded)}`);
          }
        };

        xhr.upload.onload = () => {
          setUploadProgressKnown(true);
          setUploadProgress(100);
          setUploadStatus('Saving recordings and waveforms…');
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
            return;
          }

          let message = 'Upload failed';
          try { message = JSON.parse(xhr.responseText).error || message; } catch {}
          reject(new Error(message));
        };

        xhr.onerror = () => reject(new Error('Network error while uploading'));
        xhr.onabort = () => reject(new Error('Upload canceled'));
        xhr.send(formData);
      });

      router.replace('/');
      router.refresh();
    } catch (error) {
      setUploadStatus(error instanceof Error ? error.message : 'Error uploading');
      setUploadError(error instanceof Error ? error.message : 'Error uploading');
      setUploading(false);
    }
  };

  const totalBytes = fileEntries.reduce((total, entry) => total + entry.file.size, 0);
  const queuedEntries = fileEntries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.file.name.toLowerCase().includes(queueSearch.trim().toLowerCase()));
  const brand = archiveName.trim().split(/\s+/);
  const brandAccent = brand.pop();
  const batchGroups = [
    { key: 'instruments' as const, label: 'Instruments', options: instrumentOptions, selected: folderInstruments, draft: newInstrument, setDraft: setNewInstrument, add: addInstrument, placeholder: 'Add instrument' },
    { key: 'vibes' as const, label: 'Vibes', options: vibeOptions, selected: folderVibes, draft: newVibe, setDraft: setNewVibe, add: addVibe, placeholder: 'Add vibe' },
    { key: 'collections' as const, label: 'Collections', options: collectionOptions, selected: folderCollections, draft: newCollection, setDraft: setNewCollection, add: addCollection, placeholder: 'Add collection' },
  ];
  const clearQueue = () => {
    activeAudioRef.current?.pause();
    fileEntries.forEach(entry => URL.revokeObjectURL(entry.previewUrl));
    setFileEntries([]); setQueueSearch(''); setUploadError('');
  };

  return <div {...getRootProps({ role: 'presentation', tabIndex: -1 })} className={`archive-shell ${s.shell} ${u.shell}`}>
    <input {...getInputProps({ 'aria-label': 'Choose audio files' })}/>
    {isDragActive && <div className={u.dropOverlay}><Icon name="music" size={36}/><strong>Drop audio files</strong></div>}
    <header className={s.header}>
      <Link href="/" className={s.back}><Icon name="back" size={15}/> Back to archive</Link>
      <Link href="/" className={s.brand} aria-label="Archive homepage"><svg viewBox="0 0 120 44" aria-hidden="true"><path d="M4 22h11l5-9 6 18 7-28 8 38 8-26 6 11 5-16 5 30 8-36 7 27 6-14 5 5h24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 22h112" stroke="#dce7f3" strokeWidth="2"/></svg><span>{brand.join(' ')}{brand.length ? ' ' : ''}<em>{brandAccent}</em></span></Link>
      <div className={s.headerActions}>{userName && <span className={s.avatar} title={userName}>{userName.trim().split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase()}</span>}</div>
    </header>
    <div className={s.layout}>
      <aside className={s.sidebar}>
        <div className={s.sideLabel}>WORKSPACE</div>
        <nav aria-label="Management sections">
          <Link href="/manage" className={s.navItem}><Icon name="library"/><span>Management</span><Icon name="arrow" size={13}/></Link>
          <Link href="/upload" className={`${s.navItem} ${s.navActive}`} aria-current="page"><Icon name="plus"/><span>Upload recordings</span>{fileEntries.length > 0 && <small>{fileEntries.length}</small>}</Link>
        </nav>
        <div className={s.sideLabel}>ADMINISTRATION</div>
        <nav aria-label="Administration"><Link href="/users" className={s.navItem}><Icon name="users"/><span>Members & access</span><Icon name="arrow" size={13}/></Link></nav>
      </aside>
      <main className={`${s.main} ${u.main}`}>
        <div className={s.heading}><h1>Upload recordings</h1><div className={u.headingActions}><button type="button" className={s.secondary} disabled={uploading} onClick={openFilePicker}><Icon name="plus" size={15}/> Add files</button><button type="submit" form="upload-form" className={s.primary} disabled={!fileEntries.length || uploading}><UploadIcon/>{uploading ? 'Uploading…' : 'Upload all'}{fileEntries.length > 0 && <span className={u.buttonCount}>{fileEntries.length}</span>}</button></div></div>
        {uploadError && <div className={u.error} role="alert"><Icon name="close" size={16}/><span>{uploadError}</span><button type="button" aria-label="Dismiss error" onClick={() => setUploadError('')}><Icon name="close" size={14}/></button></div>}
        <form id="upload-form" onSubmit={handleSubmit}>
          <fieldset className={u.workspace} disabled={uploading}>
            <div className={u.queueColumn}>
              <button type="button" className={`${u.dropzone} ${isDragActive ? u.dropActive : ''}`} onClick={openFilePicker}>
                <span className={u.uploadSymbol}><UploadIcon size={26}/></span>
                <strong>Drop audio files here</strong><span>or <b>choose files</b></span>
                <small>WAV · MP3 · M4A · FLAC · AAC · AIFF · OGG</small>
              </button>
              <section className={s.content} aria-label="Upload queue">
                <div className={s.sectionHead}><h2>Upload queue <span className={u.queueCount}>{fileEntries.length}</span></h2>{fileEntries.length > 0 && <button type="button" className={u.subtleButton} onClick={clearQueue}>Clear queue</button>}</div>
                {fileEntries.length > 0 && <div className={`${s.toolbar} ${u.queueToolbar}`}><label className={s.search}><Icon name="search" size={16}/><input aria-label="Search queued recordings" placeholder="Find a recording…" value={queueSearch} onChange={event => setQueueSearch(event.target.value)}/>{queueSearch && <button type="button" aria-label="Clear queue search" onClick={() => setQueueSearch('')}><Icon name="close" size={13}/></button>}</label><span>{queuedEntries.length} recordings</span></div>}
                {fileEntries.length === 0 ? <div className={u.emptyQueue}><span className={u.emptyIcon}><Icon name="music" size={24}/></span><h3>No recordings queued</h3><button type="button" className={s.textLink} onClick={openFilePicker}>Choose audio files <Icon name="arrow" size={13}/></button></div> : queuedEntries.length === 0 ? <div className={u.emptyQueue}><h3>No matching recordings</h3><button type="button" className={s.textLink} onClick={() => setQueueSearch('')}>Clear search</button></div> : queuedEntries.map(({ entry, index }) => <article key={entry.id} className={u.recording} aria-label={entry.file.name}>
                  <div className={u.recordingHead}><span className={u.fileIcon}><Icon name="music" size={18}/></span><div className={u.fileTitle}><h3>{entry.file.name}</h3><span>{formatBytes(entry.file.size)}<i/>Recorded {entry.year}</span></div><select value={entry.finish} aria-label={`Type for ${entry.file.name}`} onChange={event => updateEntry(index, 'finish', event.target.value)}><option value="">Unspecified</option>{FINISH_OPTIONS.map(option => <option key={option}>{option}</option>)}</select><button type="button" className={u.remove} aria-label={`Remove ${entry.file.name}`} title="Remove from queue" onClick={() => removeEntry(index)}><Icon name="close" size={16}/></button></div>
                  <TemporaryWaveformPreview source={entry.file} src={entry.previewUrl} name={entry.file.name} onPlay={handlePreviewPlay}/>
                  <details className={u.fileDetails}><summary><span>Recording details</span><span className={u.tagSummary}>{[...entry.instruments, ...entry.vibes, ...entry.collections].slice(0, 3).map((tag, tagIndex) => <span key={`${tag}-${tagIndex}`}>{displayTag(tag)}</span>)}</span><Icon name="arrow" size={12}/></summary><div className={u.metadataGrid}>
                    {batchGroups.map(group => <TagPicker key={group.key} label={group.label} options={group.options} selected={entry[group.key]} onToggle={tag => toggleEntryTag(index, group.key, tag)}/>)}
                    <div className={u.fileFields}><label>Year<input type="number" min="1900" max="2100" defaultValue={entry.year} onBlur={event => updateEntryYear(index, event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }}/></label><fieldset className={u.tagPicker}><legend>Rating</legend><RatingInput value={entry.rating} onChange={rating => updateEntry(index, 'rating', rating)}/></fieldset></div>
                    <label className={u.notes}>Notes<textarea value={entry.notes} onChange={event => updateEntry(index, 'notes', event.target.value)} placeholder="Add notes…" maxLength={10000}/></label>
                  </div></details>
                </article>)}
                <div className={s.tableFooter}><span>{fileEntries.length} recordings · {formatBytes(totalBytes)}</span><span>200 files per batch · 500 MB per file</span></div>
              </section>
            </div>
            <aside className={u.batch} aria-label="Batch settings">
              <div className={u.batchHead}><Icon name="collections" size={17}/><h2>Batch settings</h2></div><p className={u.batchHint}>Applies to all queued recordings.</p>
              {optionError && <p className={u.optionError} role="status">{optionError}</p>}
              <fieldset className={`${u.tagPicker} ${u.batchType}`}><legend>Type</legend><div className={u.tags}>{FINISH_OPTIONS.map(option => <button type="button" key={option} aria-pressed={folderFinish === option} className={folderFinish === option ? u.tagSelected : ''} onClick={() => toggleFolderFinish(option)}>{option}</button>)}</div></fieldset>
              {batchGroups.map(group => <div className={u.batchGroup} key={group.key}><TagPicker label={group.label} options={group.options} selected={group.selected} onToggle={tag => toggleFolderTag(group.key, tag)}/><div className={u.addTag}><input aria-label={group.placeholder} placeholder={group.placeholder} value={group.draft} onChange={event => group.setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); group.add(); } }}/><button type="button" aria-label={`Create ${group.label.toLowerCase()} tag`} disabled={!group.draft.trim()} onClick={group.add}><Icon name="plus" size={14}/></button></div></div>)}
              <fieldset className={`${u.tagPicker} ${u.batchRating}`}><legend>Rating</legend><RatingInput value={folderRating} onChange={updateFolderRating}/></fieldset>
              <div className={u.batchFoot}><Icon name="shield" size={14}/><span>Up to 5 GB per batch</span></div>
            </aside>
          </fieldset>

          <section hidden className={u.finderHidden} aria-hidden="true">
        <div className="mb-4 rounded border border-border bg-muted p-4">
          <label className="mb-2 block text-sm font-medium text-foreground">Apply Finder color tag JSON to upload queue</label>
          <div className="flex flex-wrap items-center gap-3">
            <label className={`cursor-pointer rounded border border-border bg-background px-4 py-3 text-sm text-muted-foreground transition hover:border-accent hover:text-foreground sm:py-2 ${
              fileEntries.length === 0 ? 'opacity-50' : ''
            }`}>
              Choose JSON
              <input
                type="file"
                accept="application/json,.json"
                className="hidden"
                disabled={fileEntries.length === 0}
                onChange={(event) => {
                  void applyFinderTagMetadata(event.target.files?.[0] || null);
                  event.currentTarget.value = '';
                }}
              />
            </label>
            <button
              type="button"
              role="switch"
              aria-checked={useFinderColorRating}
              onClick={() => setUseFinderColorRating(enabled => !enabled)}
              className={`rounded border px-3 py-2 text-xs transition ${
                useFinderColorRating
                  ? 'border-accent bg-accent text-accent-foreground'
                  : 'border-border bg-background text-muted-foreground hover:border-accent hover:text-foreground'
              }`}
            >
              Use Finder Color-Rating logic: {useFinderColorRating ? 'On' : 'Off'}
            </button>
            {finderTagFileName && (
              <span className="text-sm text-muted-foreground">{finderTagFileName}</span>
            )}
            {finderTagImportStatus && (
              <span className="text-sm text-muted-foreground">{finderTagImportStatus}</span>
            )}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Color tags are always imported. With rating logic on: Yellow = 2, Green = 3, Blue = 5, Yellow + Green = 2, Blue + Green = 4, and 4+ colors = 5. Other matches keep the fallback rating.
          </p>
        </div>
          </section>
        </form>
        {uploading && <div className={u.uploadProgress} role="status"><div><span className={u.progressIcon}><UploadIcon size={18}/></span><div><strong>{uploadProgress === 100 ? 'Processing recordings' : 'Uploading recordings'}</strong><p>{uploadStatus}</p></div><b>{uploadProgressKnown ? `${uploadProgress}%` : '…'}</b></div><progress max={100} value={uploadProgressKnown ? uploadProgress : undefined} aria-label="Upload progress"/></div>}
      </main>
    </div>
  </div>;
}

function UploadIcon({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/></svg>;
}
