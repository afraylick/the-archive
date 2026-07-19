'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useDropzone } from 'react-dropzone';
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
  <svg className="h-8 w-8" viewBox="0 0 24 24" aria-hidden="true">
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
    <div className="flex space-x-1">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          onClick={() => onChange(star)}
          onMouseEnter={() => setHoveredRating(star)}
          onMouseLeave={() => setHoveredRating(0)}
          className={`inline-flex h-10 w-10 items-center justify-center ${star <= displayedRating ? getRatingColor(displayedRating) : 'text-muted-foreground'}`}
        >
          <StarIcon filled={star <= displayedRating} />
        </button>
      ))}
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
  <div>
    <label className="block text-sm font-medium mb-1 text-foreground">{label}</label>
    <div className="flex flex-wrap gap-2">
      {options.map(option => (
        <button
          key={option}
          type="button"
          onClick={() => onToggle(option)}
          className={`rounded border px-3 py-2 text-sm transition sm:px-2 sm:py-1 ${
            selected.includes(option)
              ? 'border-accent bg-accent text-accent-foreground'
              : 'border-border bg-background text-muted-foreground hover:bg-background/80'
          }`}
        >
          {displayTag(option)}
        </button>
      ))}
    </div>
  </div>
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
  const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);
  const [uploading, setUploading] = useState(false);
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
      .then((data: { settings?: { defaultInstruments?: string[]; defaultVibes?: string[] } }) => {
        setInstrumentOptions(prev => Array.from(new Set([...prev, ...(data.settings?.defaultInstruments || [])])));
        setVibeOptions(prev => Array.from(new Set([...prev, ...(data.settings?.defaultVibes || [])])));
      });

    fetch('/api/files')
      .then(res => res.json())
      .then((files: AudioFile[]) => {
        setInstrumentOptions(prev => Array.from(new Set([...prev, ...files.flatMap(file => getTags(file, 'instruments', 'instrument'))])));
        setVibeOptions(prev => Array.from(new Set([...prev, ...files.flatMap(file => getTags(file, 'vibes', 'vibe'))])));
        setCollectionOptions(prev => Array.from(new Set([...prev, ...files.flatMap(file => Array.isArray(file.collections) ? file.collections.filter(Boolean) : [])])).sort((a, b) => a.localeCompare(b)));
      });
  }, []);

  const createFileEntries = (files: File[]) => files.map(file => {
      const filenameRecordedDate = getRecordedDateFromFilename(file.name);
      const createdAt = filenameRecordedDate?.createdAt || new Date(file.lastModified).toISOString();

      return {
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
  });

  const updateEntry = (index: number, field: keyof FileEntry, value: string[] | number | string | boolean) => {
    setFileEntries(prev => prev.map((entry, i) =>
      i === index ? { ...entry, [field]: value } : entry
    ));
  };

  const updateEntryFinish = (index: number, finish: string) => {
    setFileEntries(prev => prev.map((entry, i) =>
      i === index ? { ...entry, finish: entry.finish === finish ? '' : finish } : entry
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
    if (fileEntries.length === 0) return;

    setUploading(true);
    setUploadProgress(0);
    setUploadProgressKnown(false);
    setUploadStatus('Preparing upload...');
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
          setUploadStatus('Upload sent. Server is saving files and generating full waveforms...');
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
            return;
          }

          reject(new Error(xhr.responseText || 'Upload failed'));
        };

        xhr.onerror = () => reject(new Error('Network error while uploading'));
        xhr.onabort = () => reject(new Error('Upload canceled'));
        xhr.send(formData);
      });

      window.location.href = '/';
    } catch (error) {
      setUploadStatus(error instanceof Error ? error.message : 'Error uploading');
      alert(error instanceof Error ? error.message : 'Error uploading');
      setUploading(false);
    }
  };

  return (
    <div {...getRootProps()} className="container relative mx-auto min-h-screen bg-background p-4 text-foreground">
      <input {...getInputProps()} />
      {isDragActive && (
        <div className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center border-4 border-dashed border-accent bg-background/90 p-8 text-center text-xl font-semibold text-foreground backdrop-blur-sm">
          Drop audio files and optional Finder JSON anywhere on this page
        </div>
      )}
      <div className="mb-4 flex items-center gap-3">
        <button
          type="button"
          onClick={() => window.location.href = '/'}
          className="rounded border border-border px-3 py-3 text-sm text-muted-foreground transition hover:text-foreground sm:py-2"
        >
          Back
        </button>
        <h1 className="text-2xl font-bold">Upload Audio Files</h1>
      </div>
      <form onSubmit={handleSubmit}>
        {uploading && (
          <div className="fixed inset-x-3 bottom-3 z-50 rounded border border-accent/40 bg-background/95 p-4 shadow-2xl shadow-black/30 backdrop-blur sm:left-auto sm:w-[26rem]">
            <div className="mb-2 flex items-center justify-between gap-3 text-sm">
              <span className="font-medium text-foreground">{uploadStatus || 'Uploading...'}</span>
              <span className="shrink-0 text-muted-foreground">{uploadProgressKnown ? `${uploadProgress}%` : 'Sending...'}</span>
            </div>
            <div className="h-3 overflow-hidden rounded bg-muted">
              {uploadProgressKnown ? (
                <div
                  className="h-full rounded bg-accent transition-all"
                  style={{ width: `${uploadProgress}%` }}
                />
              ) : (
                <div className="h-full w-1/3 animate-pulse rounded bg-accent" />
              )}
            </div>
          </div>
        )}
        <div
          className="mb-4 cursor-pointer border-2 border-dashed border-border bg-muted p-8"
          onClick={openFilePicker}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') openFilePicker();
          }}
        >
          <p className="text-foreground">Drag audio files anywhere on this page, or click here to select files</p>
          <p className="mt-2 text-sm text-muted-foreground">You can include one Finder color-tag JSON file in the same drop.</p>
        </div>
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
        <div className="mb-4 rounded border border-border bg-muted p-4">
          <div className="mb-2">
            <h2 className="text-sm font-semibold text-foreground">Bulk tagging</h2>
            <p className="text-xs text-muted-foreground">Changes apply immediately to every queued song.</p>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
            <TagPicker
              label="Instrument"
              options={instrumentOptions}
              selected={folderInstruments}
              onToggle={(tag) => toggleFolderTag('instruments', tag)}
            />
            <TagPicker
              label="Vibe"
              options={vibeOptions}
              selected={folderVibes}
              onToggle={(tag) => toggleFolderTag('vibes', tag)}
            />
            <TagPicker
              label="Collections"
              options={collectionOptions}
              selected={folderCollections}
              onToggle={(tag) => toggleFolderTag('collections', tag)}
            />
            <div>
              <label className="block text-sm font-medium mb-1 text-foreground">Finish</label>
              <div className="flex flex-wrap gap-2">
                {FINISH_OPTIONS.map(option => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => toggleFolderFinish(option)}
                    className={`rounded border px-3 py-2 text-sm transition sm:px-2 sm:py-1 ${
                      folderFinish === option
                        ? 'border-accent bg-accent text-accent-foreground'
                        : 'border-border bg-background text-muted-foreground hover:bg-background/80'
                    }`}
                  >
                    {option}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Select again to clear the finish on the queue.</p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1 text-foreground">Fallback Rating</label>
              <RatingInput value={folderRating} onChange={updateFolderRating} />
              <p className="mt-1 text-xs text-muted-foreground">
                Finder colors override this only when color-rating logic is enabled.
              </p>
            </div>
          </div>
        </div>
        <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className="flex">
            <input
              type="text"
              value={newInstrument}
              onChange={(e) => setNewInstrument(e.target.value)}
              placeholder="Add instrument tag"
              className="min-w-0 flex-1 rounded-l border border-border bg-background p-3 text-sm text-foreground sm:p-2"
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addInstrument())}
            />
            <button type="button" onClick={addInstrument} className="rounded-r bg-accent px-4 py-3 text-accent-foreground hover:bg-accent/80 sm:px-3 sm:py-2">
              +
            </button>
          </div>
          <div className="flex">
            <input
              type="text"
              value={newVibe}
              onChange={(e) => setNewVibe(e.target.value)}
              placeholder="Add vibe tag"
              className="min-w-0 flex-1 rounded-l border border-border bg-background p-3 text-sm text-foreground sm:p-2"
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addVibe())}
            />
            <button type="button" onClick={addVibe} className="rounded-r bg-accent px-4 py-3 text-accent-foreground hover:bg-accent/80 sm:px-3 sm:py-2">
              +
            </button>
          </div>
          <div className="flex">
            <input
              type="text"
              value={newCollection}
              onChange={(e) => setNewCollection(e.target.value)}
              placeholder="Add collection"
              className="min-w-0 flex-1 rounded-l border border-border bg-background p-3 text-sm text-foreground sm:p-2"
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addCollection())}
            />
            <button type="button" onClick={addCollection} className="rounded-r bg-accent px-4 py-3 text-accent-foreground hover:bg-accent/80 sm:px-3 sm:py-2">
              +
            </button>
          </div>
        </div>
        {fileEntries.length > 0 && (
          <div className="mb-4">
            <h2 className="text-lg font-semibold mb-2 text-foreground">Files to Upload</h2>
            {fileEntries.map((entry, index) => (
              <div key={`${entry.file.name}-${index}`} className="border border-border p-4 mb-2 rounded bg-muted">
                <div className="flex justify-between items-center mb-2 gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-foreground">{entry.file.name}</span>
                    {entry.colorTags.length > 0 && (
                      <div className="flex shrink-0">
                        {entry.colorTags.filter(color => FINDER_COLOR_HEX[color]).map(color => (
                          <span
                            key={color}
                            className="-ml-1 first:ml-0 h-3.5 w-3.5 rounded-full border border-background"
                            style={{ backgroundColor: FINDER_COLOR_HEX[color] }}
                            title={displayTag(color)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                  <button type="button" onClick={() => removeEntry(index)} className="text-red-500 hover:text-red-700">Remove</button>
                </div>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-8">
                  <TagPicker
                    label="Instrument"
                    options={instrumentOptions}
                    selected={entry.instruments}
                    onToggle={(tag) => toggleEntryTag(index, 'instruments', tag)}
                  />
                  <TagPicker
                    label="Vibe"
                    options={vibeOptions}
                    selected={entry.vibes}
                    onToggle={(tag) => toggleEntryTag(index, 'vibes', tag)}
                  />
                  <TagPicker
                    label="Collections"
                    options={collectionOptions}
                    selected={entry.collections}
                    onToggle={(tag) => toggleEntryTag(index, 'collections', tag)}
                  />
                  <div>
                    <label className="block text-sm font-medium mb-1 text-foreground">Rating</label>
                    <RatingInput value={entry.rating} onChange={(rating) => updateEntry(index, 'rating', rating)} />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1 text-foreground">Finish</label>
                    <div className="flex flex-wrap gap-2">
                      {FINISH_OPTIONS.map(option => (
                        <button
                          key={option}
                          type="button"
                          onClick={() => updateEntryFinish(index, option)}
                          className={`rounded border px-3 py-2 text-sm transition sm:px-2 sm:py-1 ${
                            entry.finish === option
                              ? 'border-accent bg-accent text-accent-foreground'
                              : 'border-border bg-background text-muted-foreground hover:bg-background/80'
                          }`}
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1 text-foreground">Year</label>
                    <input
                      type="number"
                      min="1900"
                      max="2100"
                      defaultValue={entry.year}
                      onBlur={(event) => updateEntryYear(index, event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur();
                      }}
                      className="w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-accent sm:px-2 sm:py-1"
                    />
                  </div>
                  <div className="xl:col-span-2">
                    <label className="block text-sm font-medium mb-1 text-foreground">Preview</label>
                    <TemporaryWaveformPreview
                      source={entry.file}
                      src={entry.previewUrl}
                      name={entry.file.name}
                      onPlay={handlePreviewPlay}
                    />
                  </div>
                </div>
                <div className="mt-4">
                  <label className="block text-sm font-medium mb-1 text-foreground">Notes</label>
                  <textarea
                    value={entry.notes}
                    onChange={(event) => updateEntry(index, 'notes', event.target.value)}
                    placeholder="Add notes for this song..."
                    className="min-h-24 w-full resize-y rounded border border-border bg-background p-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-accent"
                  />
                </div>
              </div>
            ))}
          </div>
        )}
        <button
          type="submit"
          disabled={fileEntries.length === 0 || uploading}
          className="relative overflow-hidden rounded bg-accent px-4 py-3 text-accent-foreground hover:bg-accent/80 disabled:opacity-50 sm:py-2"
        >
          {uploading && uploadProgressKnown && (
            <span
              className="absolute inset-y-0 left-0 bg-white/20 transition-all"
              style={{ width: `${uploadProgress}%` }}
              aria-hidden="true"
            />
          )}
          <span className="relative">{uploading ? `Uploading${uploadProgressKnown ? ` ${uploadProgress}%` : '...'}` : 'Upload All'}</span>
        </button>
        {uploading && (
          <div className="mt-4 max-w-xl rounded border border-border bg-muted p-3">
            <div className="mb-2 flex items-center justify-between gap-3 text-sm text-muted-foreground">
              <span>{uploadStatus || 'Uploading...'}</span>
              <span>{uploadProgress}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded bg-background">
              <div
                className="h-full rounded bg-accent transition-all"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
