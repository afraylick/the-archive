'use client';

import { useEffect, useRef, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { getRecordedDateFromFilename } from '@/lib/recorded-date';

const DEFAULT_INSTRUMENTS = ['E. Guitar', 'Keys', 'Vocal', 'Synth', 'Acoustic', 'Bass', 'Drums', 'Drum Machine', 'Uku'];
const DEFAULT_VIBES = ['ambient', 'rock', 'indie', 'acoustic', 'hard', 'soft', 'country', 'electronic', 'Chill', 'Gainy', 'Spacey', 'Beats', 'Group Jam'];
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

const deriveRatingFromColorTags = (colorTags: string[], fallbackRating: number) => {
  const colors = new Set(colorTags);
  if (colorTags.length > 3) return 5;
  if (colors.has('yellow') && colors.has('green')) return 2;
  if (colors.has('blue') && colors.has('green')) return 5;
  if (colors.has('blue')) return 4;
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

interface AudioFile {
  instrument?: string;
  vibe?: string;
  instruments?: string[];
  vibes?: string[];
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
          className={`rounded px-3 py-2 text-sm transition sm:px-2 sm:py-1 ${
            selected.includes(option)
              ? 'bg-accent text-accent-foreground'
              : 'bg-background text-muted-foreground border border-border hover:bg-background/80'
          }`}
        >
          {displayTag(option)}
        </button>
      ))}
    </div>
  </div>
);

const AudioPreview = ({ entry, onPlay }: { entry: FileEntry; onPlay: (audio: HTMLAudioElement) => void }) => {
  return (
    <audio
      controls
      preload="metadata"
      src={entry.previewUrl}
      className="w-full"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onPlay={(event) => onPlay(event.currentTarget)}
    >
      Your browser does not support the audio element.
    </audio>
  );
};

const FolderAudioPreview = ({ entry, onPlay }: { entry: FolderEntry; onPlay: (audio: HTMLAudioElement) => void }) => {
  return (
    <audio
      controls
      preload="metadata"
      src={`/api/import-folder?path=${encodeURIComponent(entry.path)}`}
      className="w-full"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onPlay={(event) => onPlay(event.currentTarget)}
    >
      Your browser does not support the audio element.
    </audio>
  );
};

interface FileEntry {
  file: File;
  previewUrl: string;
  instruments: string[];
  vibes: string[];
  finish: string;
  notes: string;
  year: number;
  createdAt: string;
  colorTags: string[];
  rating: number;
  bobs: boolean;
}

interface FolderEntry {
  path: string;
  name: string;
  instruments: string[];
  vibes: string[];
  finish: string;
  notes: string;
  year: number;
  createdAt: string;
  colorTags: string[];
  rating: number;
  bobs: boolean;
}

export default function UploadPage() {
  const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadProgressKnown, setUploadProgressKnown] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');
  const [finderTagImportStatus, setFinderTagImportStatus] = useState('');
  const [importingFolder, setImportingFolder] = useState(false);
  const [loadingFolder, setLoadingFolder] = useState(false);
  const [folderPath, setFolderPath] = useState('');
  const [folderInstruments, setFolderInstruments] = useState<string[]>([]);
  const [folderVibes, setFolderVibes] = useState<string[]>([]);
  const [folderFinish, setFolderFinish] = useState('');
  const [folderRating, setFolderRating] = useState(0);
  const [folderBobs, setFolderBobs] = useState(false);
  const [folderEntries, setFolderEntries] = useState<FolderEntry[]>([]);
  const [instrumentOptions, setInstrumentOptions] = useState<string[]>(DEFAULT_INSTRUMENTS);
  const [vibeOptions, setVibeOptions] = useState<string[]>(DEFAULT_VIBES);
  const [newInstrument, setNewInstrument] = useState('');
  const [newVibe, setNewVibe] = useState('');
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
    fetch('/api/files')
      .then(res => res.json())
      .then((files: AudioFile[]) => {
        setInstrumentOptions(prev => Array.from(new Set([...prev, ...files.flatMap(file => getTags(file, 'instruments', 'instrument'))])));
        setVibeOptions(prev => Array.from(new Set([...prev, ...files.flatMap(file => getTags(file, 'vibes', 'vibe'))])));
      });
  }, []);

  const onDrop = (acceptedFiles: File[]) => {
    const newEntries = acceptedFiles.map(file => {
      const filenameRecordedDate = getRecordedDateFromFilename(file.name);
      const createdAt = filenameRecordedDate?.createdAt || new Date(file.lastModified).toISOString();

      return {
        file,
        previewUrl: URL.createObjectURL(file),
        instruments: [],
        vibes: [],
        finish: filenameRecordedDate ? 'Tracked' : deriveFinishFromFilename(file.name),
        notes: '',
        year: filenameRecordedDate?.year || new Date(createdAt).getFullYear(),
        createdAt,
        colorTags: [],
        rating: 0,
        bobs: false,
      };
    });
    setFileEntries(prev => [...prev, ...newEntries]);
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'audio/*': [] },
    multiple: true,
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

  const updateFolderEntry = (index: number, field: keyof FolderEntry, value: string[] | number | string | boolean) => {
    setFolderEntries(prev => prev.map((entry, i) =>
      i === index ? { ...entry, [field]: value } : entry
    ));
  };

  const toggleEntryTag = (index: number, field: 'instruments' | 'vibes', tag: string) => {
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

  const toggleFolderTag = (field: 'instruments' | 'vibes', tag: string) => {
    const setter = field === 'instruments' ? setFolderInstruments : setFolderVibes;
    setter(prev => prev.includes(tag)
      ? prev.filter(selectedTag => selectedTag !== tag)
      : [...prev, tag]
    );
  };

  const toggleFolderEntryTag = (index: number, field: 'instruments' | 'vibes', tag: string) => {
    setFolderEntries(prev => prev.map((entry, i) => {
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

  const removeEntry = (index: number) => {
    setFileEntries(prev => {
      const entry = prev[index];
      if (entry) URL.revokeObjectURL(entry.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  };

  const applyFinderTagMetadata = async (metadataFile: File | null) => {
    if (!metadataFile) return;

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
      setFileEntries(prev => prev.map(entry => {
        const colorTags = tagsByName.get(normalizeFilename(entry.file.name));
        if (!colorTags) return entry;

        matched += 1;
        return {
          ...entry,
          colorTags,
          rating: deriveRatingFromColorTags(colorTags, entry.rating),
        };
      }));

      setFinderTagImportStatus(`Applied Finder tags to ${matched} queued file${matched === 1 ? '' : 's'}.`);
    } catch (error) {
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

  const applyFolderDefaults = (entries: FolderEntry[]) => entries.map(entry => ({
    ...entry,
    instruments: folderInstruments,
    vibes: folderVibes,
    finish: folderFinish || entry.finish,
    notes: entry.notes,
    rating: entry.rating || folderRating,
    bobs: folderBobs,
  }));

  const applyFinishToFolderEntries = () => {
    if (!folderFinish) return;
    setFolderEntries(prev => prev.map(entry => ({ ...entry, finish: folderFinish })));
  };

  const toggleFolderBobs = () => {
    setFolderBobs(prev => {
      const nextValue = !prev;
      setFolderEntries(entries => entries.map(entry => ({ ...entry, bobs: nextValue })));
      return nextValue;
    });
  };

  const addVibe = () => {
    const tag = newVibe.trim();
    if (tag && !vibeOptions.includes(tag)) {
      setVibeOptions([...vibeOptions, tag]);
      setNewVibe('');
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
        finish: entry.finish,
        notes: entry.notes,
        year: entry.year,
        createdAt: entry.createdAt,
        colorTags: entry.colorTags,
        rating: entry.rating,
        bobs: entry.bobs,
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
          setUploadStatus('Upload sent. Server is saving files...');
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

  const loadFolder = async () => {
    const trimmedPath = folderPath.trim();
    if (!trimmedPath) return;

    setLoadingFolder(true);
    try {
      const res = await fetch('/api/import-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'scan',
          folderPath: trimmedPath,
          rating: folderRating,
          bobs: folderBobs,
        }),
      });

      if (res.ok) {
        const data = await res.json() as { files: Omit<FolderEntry, 'instruments' | 'vibes'>[] };
        setFolderEntries(applyFolderDefaults(data.files.map(file => ({
          ...file,
          instruments: folderInstruments,
          vibes: folderVibes,
          finish: folderFinish || file.finish,
          notes: file.notes || '',
          bobs: folderBobs,
        }))));
      } else {
        const data = await res.json().catch(() => null);
        alert(data?.error || 'Folder load failed');
      }
    } catch {
      alert('Error loading folder');
    } finally {
      setLoadingFolder(false);
    }
  };

  const importFolder = async () => {
    const trimmedPath = folderPath.trim();
    if (!trimmedPath || folderEntries.length === 0) return;

    setImportingFolder(true);
    try {
      const res = await fetch('/api/import-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'import',
          folderPath: trimmedPath,
          files: folderEntries.map(entry => ({
            path: entry.path,
            instruments: entry.instruments,
            vibes: entry.vibes,
            finish: entry.finish,
            notes: entry.notes,
            rating: entry.rating,
            bobs: entry.bobs,
          })),
        }),
      });

      if (res.ok) {
        window.location.href = '/';
      } else {
        const data = await res.json().catch(() => null);
        alert(data?.error || 'Folder import failed');
      }
    } catch {
      alert('Error importing folder');
    } finally {
      setImportingFolder(false);
    }
  };

  return (
    <div className="container mx-auto p-4 bg-background text-foreground min-h-screen">
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
        <div {...getRootProps()} className="border-2 border-dashed border-border p-8 mb-4 cursor-pointer bg-muted">
          <input {...getInputProps()} />
          {isDragActive ? (
            <p className="text-foreground">Drop the audio files here...</p>
          ) : (
            <p className="text-foreground">Drag and drop audio files here, or click to select multiple files</p>
          )}
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
            {finderTagImportStatus && (
              <span className="text-sm text-muted-foreground">{finderTagImportStatus}</span>
            )}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Add audio files first, then choose the JSON generated on your Mac.
          </p>
        </div>
        <div className="mb-4 rounded border border-border bg-muted p-4">
          <label className="mb-2 block text-sm font-medium text-foreground">Import local folder with Finder color tags</label>
          <div className="mb-3 flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              value={folderPath}
              onChange={(event) => setFolderPath(event.target.value)}
              placeholder="/Users/adam.froehlich/Music/Folder"
              className="flex-1 rounded border border-border bg-background p-3 text-sm text-foreground sm:p-2"
            />
            <button
              type="button"
              onClick={loadFolder}
              disabled={!folderPath.trim() || loadingFolder || importingFolder}
              className="rounded bg-muted px-4 py-3 text-sm font-semibold text-muted-foreground transition hover:bg-muted/80 disabled:opacity-50 sm:py-2"
            >
              {loadingFolder ? 'Loading...' : 'Load Folder'}
            </button>
            <button
              type="button"
              onClick={importFolder}
              disabled={folderEntries.length === 0 || importingFolder || loadingFolder}
              className="rounded bg-accent px-4 py-3 text-sm font-semibold text-accent-foreground transition hover:bg-accent/80 disabled:opacity-50 sm:py-2"
            >
              {importingFolder ? 'Importing...' : 'Import Folder'}
            </button>
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
            <div>
              <label className="block text-sm font-medium mb-1 text-foreground">Finish</label>
              <div className="flex flex-wrap gap-2">
                {FINISH_OPTIONS.map(option => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setFolderFinish(prev => prev === option ? '' : option)}
                    className={`rounded px-3 py-2 text-sm transition sm:px-2 sm:py-1 ${
                      folderFinish === option
                        ? 'bg-accent text-accent-foreground'
                        : 'bg-background text-muted-foreground border border-border hover:bg-background/80'
                    }`}
                  >
                    {option}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={applyFinishToFolderEntries}
                disabled={!folderFinish || folderEntries.length === 0}
                className="mt-2 rounded bg-muted px-3 py-2 text-xs text-muted-foreground transition hover:bg-muted/80 disabled:opacity-50 sm:py-1"
              >
                Tag Queue
              </button>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1 text-foreground">Fallback Rating</label>
              <RatingInput value={folderRating} onChange={setFolderRating} />
              <p className="mt-1 text-xs text-muted-foreground">
                Finder colors override this when they match a rating rule.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1 text-foreground">Demo</label>
              <button
                type="button"
                onClick={toggleFolderBobs}
                className={`rounded px-3 py-2 text-sm transition sm:px-2 sm:py-1 ${
                  folderBobs
                    ? 'bg-accent text-accent-foreground'
                    : 'bg-background text-muted-foreground border border-border hover:bg-background/80'
                }`}
              >
                Bobs
              </button>
              <p className="mt-1 text-xs text-muted-foreground">Only the Bobs account is limited by this.</p>
            </div>
          </div>
        </div>
        <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2">
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
                <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
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
                          className={`rounded px-3 py-2 text-sm transition sm:px-2 sm:py-1 ${
                            entry.finish === option
                              ? 'bg-accent text-accent-foreground'
                              : 'bg-background text-muted-foreground border border-border hover:bg-background/80'
                          }`}
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1 text-foreground">Preview</label>
                    <AudioPreview entry={entry} onPlay={handlePreviewPlay} />
                    <button
                      type="button"
                      onClick={() => updateEntry(index, 'bobs', !entry.bobs)}
                      className={`mt-2 rounded px-3 py-2 text-xs transition sm:px-2 sm:py-1 ${
                        entry.bobs
                          ? 'bg-accent text-accent-foreground'
                          : 'bg-background text-muted-foreground border border-border hover:bg-background/80'
                      }`}
                    >
                      Bobs
                    </button>
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
        {folderEntries.length > 0 && (
          <div className="mb-4">
            <h2 className="text-lg font-semibold mb-2 text-foreground">Folder Files to Import</h2>
            {folderEntries.map((entry, index) => (
              <div key={entry.path} className="border border-border p-4 mb-2 rounded bg-muted">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <span className="block truncate text-foreground">{entry.name}</span>
                    <span className="text-xs text-muted-foreground">{entry.year}</span>
                  </div>
                  {(entry.colorTags || []).length > 0 && (
                    <div className="flex">
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
                <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
                  <TagPicker
                    label="Instrument"
                    options={instrumentOptions}
                    selected={entry.instruments}
                    onToggle={(tag) => toggleFolderEntryTag(index, 'instruments', tag)}
                  />
                  <TagPicker
                    label="Vibe"
                    options={vibeOptions}
                    selected={entry.vibes}
                    onToggle={(tag) => toggleFolderEntryTag(index, 'vibes', tag)}
                  />
                  <div>
                    <label className="block text-sm font-medium mb-1 text-foreground">Rating</label>
                    <RatingInput value={entry.rating} onChange={(rating) => updateFolderEntry(index, 'rating', rating)} />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1 text-foreground">Finish</label>
                    <div className="flex flex-wrap gap-2">
                      {FINISH_OPTIONS.map(option => (
                        <button
                          key={option}
                          type="button"
                          onClick={() => updateFolderEntry(index, 'finish', entry.finish === option ? '' : option)}
                          className={`rounded px-3 py-2 text-sm transition sm:px-2 sm:py-1 ${
                            entry.finish === option
                              ? 'bg-accent text-accent-foreground'
                              : 'bg-background text-muted-foreground border border-border hover:bg-background/80'
                          }`}
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1 text-foreground">Preview</label>
                    <FolderAudioPreview entry={entry} onPlay={handlePreviewPlay} />
                    <button
                      type="button"
                      onClick={() => updateFolderEntry(index, 'bobs', !entry.bobs)}
                      className={`mt-2 rounded px-3 py-2 text-xs transition sm:px-2 sm:py-1 ${
                        entry.bobs
                          ? 'bg-accent text-accent-foreground'
                          : 'bg-background text-muted-foreground border border-border hover:bg-background/80'
                      }`}
                    >
                      Bobs
                    </button>
                  </div>
                </div>
                <div className="mt-4">
                  <label className="block text-sm font-medium mb-1 text-foreground">Notes</label>
                  <textarea
                    value={entry.notes}
                    onChange={(event) => updateFolderEntry(index, 'notes', event.target.value)}
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
