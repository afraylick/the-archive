'use client';

import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import WaveSurfer from 'wavesurfer.js';

interface AudioFile {
  id: string;
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
  year?: number;
  createdAt?: string;
  ratings?: Record<string, number>;
  ratingUpdatedAt?: Record<string, string>;
  liked?: boolean;
  likedBy?: string[];
  stems?: StemAttachment;
  myRating: number;
  userRating: number;
  notes?: string;
  comments: AudioComment[];
  uploadedAt: string;
}

interface AudioComment {
  id: string;
  text: string;
  timestamp?: number;
  userId: string;
  userName: string;
  createdAt: string;
}

interface StemAttachment {
  id: string;
  name: string;
  uploadedAt: string;
}

interface ArchiveUser {
  id: string;
  name: string;
  isAdmin: boolean;
}

interface AudioCardProps {
  file: AudioFile;
  setFiles: React.Dispatch<React.SetStateAction<AudioFile[]>>;
  isActive: boolean;
  currentUser: ArchiveUser;
  accountUsers: ArchiveUser[];
  instrumentOptions: string[];
  vibeOptions: string[];
  collectionOptions: string[];
  onReady: (file: AudioFile, cardElement: HTMLDivElement, wavesurfer: WaveSurfer) => void;
  onPlay: (file: AudioFile, cardElement: HTMLDivElement, wavesurfer: WaveSurfer) => void;
  onPause: (file: AudioFile, wavesurfer: WaveSurfer) => void;
  onStop: (file: AudioFile, wavesurfer: WaveSurfer) => void;
  onDestroy: (file: AudioFile, wavesurfer: WaveSurfer) => void;
}

interface ActivityEntry {
  id: string;
  type: 'comment' | 'rating';
  file: AudioFile;
  userName: string;
  text: string;
  rating?: number;
  createdAt?: string;
  sortTime: number;
}

type EndMode = 'repeat' | 'next' | 'stop';
type SortBy = 'random' | 'name' | 'date' | 'uploadDate' | 'adamsRatingRandom' | 'adamsRating' | 'userRating';
type FilterCategory = 'instruments' | 'vibes' | 'collections' | 'finish' | 'years' | 'adamsRatings';
type FilterMode = 'none' | 'include' | 'exclude';
type FilterValue = string | number;

interface PlayerRegistryEntry {
  cardElement: HTMLDivElement;
  wavesurfer: WaveSurfer;
}

const DEFAULT_INSTRUMENTS = ['E. Guitar', 'Keys', 'Vocal', 'Synth', 'Acoustic', 'Bass', 'Drums', 'Drum Machine', 'Uku'];
const DEFAULT_VIBES = ['ambient', 'rock', 'indie', 'acoustic', 'hard', 'soft', 'country', 'electronic', 'Chill', 'Gainy', 'Spacey', 'Beats', 'Group Jam'];
const FINISH_OPTIONS = ['Tracked', 'Recorder', 'Voice Memo'];
const INITIAL_RENDER_LIMIT = 30;
const RENDER_BATCH_SIZE = 30;
const WAVEFORM_PEAK_LENGTH = 4000;
const WAVEFORM_PEAK_PRECISION = 10000;
const WAVEFORM_EXPORT_PRECISION = WAVEFORM_PEAK_PRECISION;
const VOL_BOOST_DB = 12;
const VOL_BOOST_GAIN = Math.pow(10, VOL_BOOST_DB / 20);
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

let sharedAudioContext: AudioContext | null = null;
const tracksStartedFromWaveformClick = new Set<string>();

const getSharedAudioContext = () => {
  sharedAudioContext ??= new AudioContext();
  return sharedAudioContext;
};

const normalizeTag = (tag: string) => TAG_LABELS[tag.toLowerCase()] || tag;

const getTags = (file: AudioFile, pluralKey: 'instruments' | 'vibes', singularKey: 'instrument' | 'vibe') => {
  const tags = file[pluralKey];
  if (Array.isArray(tags) && tags.length > 0) return tags.filter(Boolean).map(normalizeTag);
  const tag = file[singularKey];
  return tag ? [normalizeTag(tag)] : [];
};

const displayTag = (tag: string) => TAG_LABELS[tag.toLowerCase()] || tag.replace(/\b\w/g, char => char.toUpperCase());

const getNoteText = (file: AudioFile) => file.notes ?? file.comments?.filter(comment => !comment.userId).map(comment => comment.text).join('\n') ?? '';

const isUntaggedFile = (file: AudioFile) => (
  getTags(file, 'instruments', 'instrument').length === 0 &&
  getTags(file, 'vibes', 'vibe').length === 0
);

const hasAny = <T,>(values: T[], selected: T[]) => values.some(value => selected.includes(value));
const getAdamRating = (file: AudioFile) => file.ratings?.adam || file.myRating || 0;

const getRandomSortValue = (id: string, seed: number) => {
  let hash = Math.floor(seed * 1000000000);
  for (let i = 0; i < id.length; i++) {
    hash = Math.imul(hash ^ id.charCodeAt(i), 2654435761);
  }
  return hash >>> 0;
};

const compareByName = (a: AudioFile, b: AudioFile) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

const parseTimecode = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const parts = trimmed.split(':').map(part => Number(part));
  if (parts.some(part => !Number.isFinite(part) || part < 0)) return undefined;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return undefined;
};

const hasLegacyLowPrecisionWaveform = (peaks: number[]) => {
  const sampleStep = Math.max(1, Math.floor(peaks.length / 200));
  const sampledPeaks = peaks
    .filter((_, index) => index % sampleStep === 0)
    .filter(peak => Math.abs(peak) > 0.001);

  if (sampledPeaks.length < 20) return false;

  const quarterStepPeaks = sampledPeaks.filter(peak => Math.abs(peak * 4 - Math.round(peak * 4)) < 0.00001);
  return quarterStepPeaks.length / sampledPeaks.length > 0.95;
};

const hasCachedWaveform = (file: AudioFile) => {
  const peaks = file.waveformPeaks?.[0];
  return Array.isArray(file.waveformPeaks) &&
    file.waveformPeaks.length > 0 &&
    Array.isArray(peaks) &&
    peaks.length >= 512 &&
    peaks.every(peak => Number.isFinite(peak) && Math.abs(peak) <= 1) &&
    !hasLegacyLowPrecisionWaveform(peaks) &&
    typeof file.waveformDuration === 'number' &&
    file.waveformDuration > 0;
};

const createWaveformPeaks = (audioBuffer: AudioBuffer) => {
  const channelData = audioBuffer.getChannelData(0);
  const peaks: number[] = [];
  const samplesPerPeak = channelData.length / WAVEFORM_PEAK_LENGTH;

  for (let i = 0; i < WAVEFORM_PEAK_LENGTH; i++) {
    const start = Math.floor(i * samplesPerPeak);
    const end = Math.max(start + 1, Math.ceil((i + 1) * samplesPerPeak));
    let peak = 0;

    for (let sampleIndex = start; sampleIndex < end && sampleIndex < channelData.length; sampleIndex++) {
      const sample = channelData[sampleIndex];
      if (Math.abs(sample) > Math.abs(peak)) {
        peak = sample;
      }
    }

    peaks.push(Math.round(peak * WAVEFORM_PEAK_PRECISION) / WAVEFORM_PEAK_PRECISION);
  }

  return [peaks];
};

const getCreatedDateValue = (file: AudioFile) => {
  if (file.createdAt) {
    const timestamp = new Date(file.createdAt).getTime();
    if (!Number.isNaN(timestamp)) return timestamp;
  }
  if (file.year) return Date.UTC(file.year, 0, 1);
  return 0;
};

const getUploadedDateFromId = (id: string) => {
  const timestampText = id.match(/^(\d{12,})-/)?.[1];
  if (!timestampText) return 0;

  const timestamp = Number(timestampText);
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const getUploadedDateValue = (file: AudioFile) => {
  if (file.uploadedAt) {
    const timestamp = new Date(file.uploadedAt).getTime();
    if (!Number.isNaN(timestamp)) return timestamp;
  }
  return getUploadedDateFromId(file.id) || getCreatedDateValue(file);
};

const formatCreatedDate = (file: AudioFile) => {
  const timestamp = getCreatedDateValue(file);
  if (!timestamp) return 'Unknown created date';
  return new Intl.DateTimeFormat('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: '2-digit',
  }).format(new Date(timestamp));
};

const formatDuration = (duration: number | undefined) => {
  if (!duration || duration <= 0 || !Number.isFinite(duration)) return '';

  const totalSeconds = Math.round(duration);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

const formatCommentDate = (createdAt: string) => {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return 'Unknown comment date';

  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
  const day = new Intl.DateTimeFormat('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: '2-digit',
  }).format(date);

  return `Commented at ${time}, ${day}`;
};

const formatActivityTime = (createdAt?: string) => {
  if (!createdAt) return 'current';

  const timestamp = new Date(createdAt).getTime();
  if (Number.isNaN(timestamp)) return 'unknown';

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (elapsedSeconds < 60) return 'just now';

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays}d ago`;

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(timestamp));
};

const formatActivityTitle = (activity: ActivityEntry) => {
  if (!activity.createdAt) return activity.type === 'rating' ? 'Rating timestamp unavailable' : 'Current activity';
  if (activity.type === 'comment') return formatCommentDate(activity.createdAt);

  const commentTitle = formatCommentDate(activity.createdAt);
  return commentTitle.replace('Commented', 'Rated');
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

const StarIcon = ({ filled, size = 'h-4 w-4' }: { filled: boolean; size?: string }) => (
  <svg className={size} viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M12 3.5l2.58 5.23 5.77.84-4.18 4.07.99 5.75L12 16.68l-5.16 2.71.99-5.75-4.18-4.07 5.77-.84L12 3.5z"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
    />
  </svg>
);

const AudioCard = ({
  file,
  setFiles,
  isActive,
  currentUser,
  accountUsers,
  instrumentOptions,
  vibeOptions,
  collectionOptions,
  onReady,
  onPlay,
  onPause,
  onStop,
  onDestroy,
}: AudioCardProps) => {
  const waveformRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const mediaSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const [hoveredAdamRating, setHoveredAdamRating] = useState(0);
  const [hoveredUserRating, setHoveredUserRating] = useState(0);
  const [openTagPicker, setOpenTagPicker] = useState<'instruments' | 'vibes' | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(file.name);
  const [showNotes, setShowNotes] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [showCollections, setShowCollections] = useState(false);
  const [showNewCollectionForm, setShowNewCollectionForm] = useState(false);
  const [newCollection, setNewCollection] = useState('');
  const [newComment, setNewComment] = useState('');
  const [usePlayheadTime, setUsePlayheadTime] = useState(true);
  const [commentTimecode, setCommentTimecode] = useState('');
  const [noteText, setNoteText] = useState(() => getNoteText(file));
  const [isVolumeBoosted, setIsVolumeBoosted] = useState(false);
  const [volumeBoostConfirming, setVolumeBoostConfirming] = useState(false);
  const [waveformRefreshing, setWaveformRefreshing] = useState(false);
  const [waveformRefreshKey, setWaveformRefreshKey] = useState(0);
  const [shouldMountWaveform, setShouldMountWaveform] = useState(false);
  const [duration, setDuration] = useState(file.waveformDuration || 0);
  const [currentTime, setCurrentTime] = useState(0);
  const initialWaveformCacheRef = useRef({
    peaks: hasCachedWaveform(file) ? file.waveformPeaks : undefined,
    duration: hasCachedWaveform(file) ? file.waveformDuration : undefined,
  });
  const latestFileRef = useRef(file);

  useEffect(() => {
    latestFileRef.current = file;
  }, [file]);

  useEffect(() => {
    const cardElement = cardRef.current;
    if (!cardElement || shouldMountWaveform) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShouldMountWaveform(true);
          observer.disconnect();
        }
      },
      { rootMargin: '900px 0px' }
    );

    observer.observe(cardElement);
    return () => observer.disconnect();
  }, [shouldMountWaveform]);

  const shouldRenderWaveform = shouldMountWaveform || isActive;

  useEffect(() => {
    if (!shouldRenderWaveform) return;
    if (!waveformRef.current || !cardRef.current) return;

    const wavesurfer = WaveSurfer.create({
      container: waveformRef.current,
      waveColor: '#a3a3a3',
      progressColor: '#525252',
      height: window.innerWidth < 640 ? 224 : 176,
      interact: false,
      url: `/api/files/${encodeURIComponent(latestFileRef.current.id)}/audio`,
      peaks: initialWaveformCacheRef.current.peaks,
      duration: initialWaveformCacheRef.current.duration,
    });

    wavesurferRef.current = wavesurfer;
    onReady(latestFileRef.current, cardRef.current, wavesurfer);

    const handlePlay = () => {
      if (cardRef.current) {
        onPlay(latestFileRef.current, cardRef.current, wavesurfer);
      }
    };
    const handlePause = () => onPause(latestFileRef.current, wavesurfer);
    const handleFinish = () => onStop(latestFileRef.current, wavesurfer);
    const handleError = (error: Error) => console.error('WaveSurfer error for', latestFileRef.current.id, error);
    const handleReady = (readyDuration: number) => {
      setDuration(readyDuration);
      setCurrentTime(wavesurfer.getCurrentTime());
    };
    const handleTimeUpdate = (time: number) => setCurrentTime(time);
    const handleDecode = async (duration: number) => {
      const latestFile = latestFileRef.current;
      setDuration(duration);
      if (hasCachedWaveform(latestFile) || duration <= 0) return;

      const waveformPeaks = wavesurfer.exportPeaks({
        channels: 1,
        maxLength: WAVEFORM_PEAK_LENGTH,
        precision: WAVEFORM_EXPORT_PRECISION,
      });
      if (!waveformPeaks[0]?.length) return;

      const updatedFile = {
        ...latestFile,
        waveformPeaks,
        waveformDuration: duration,
      };

      try {
        const res = await fetch(`/api/files/${encodeURIComponent(latestFile.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updatedFile),
        });

        if (res.ok) {
          setFiles(prev => prev.map(f => f.id === latestFile.id ? updatedFile : f));
        }
      } catch (error) {
        console.error('Failed to cache waveform for', latestFile.id, error);
      }
    };

    wavesurfer.on('play', handlePlay);
    wavesurfer.on('pause', handlePause);
    wavesurfer.on('finish', handleFinish);
    wavesurfer.on('error', handleError);
    wavesurfer.on('ready', handleReady);
    wavesurfer.on('timeupdate', handleTimeUpdate);
    wavesurfer.on('seeking', handleTimeUpdate);
    wavesurfer.on('decode', handleDecode);

    return () => {
      onDestroy(latestFileRef.current, wavesurfer);
      gainNodeRef.current?.disconnect();
      gainNodeRef.current = null;
      mediaSourceRef.current?.disconnect();
      mediaSourceRef.current = null;
      wavesurfer.destroy();
      wavesurferRef.current = null;
    };
  }, [onDestroy, onPause, onPlay, onReady, onStop, setFiles, shouldRenderWaveform, waveformRefreshKey]);

  useEffect(() => {
    if (!volumeBoostConfirming) return;

    const timeoutId = window.setTimeout(() => setVolumeBoostConfirming(false), 2500);
    return () => window.clearTimeout(timeoutId);
  }, [volumeBoostConfirming]);

  useEffect(() => {
    wavesurferRef.current?.setOptions({
      progressColor: isActive ? '#5e9ec5' : '#525252',
    });
  }, [isActive]);

  const handleUserRatingChange = async (newRating: number, userId = currentUser.id) => {
    const res = await fetch(`/api/files/${encodeURIComponent(file.id)}/rating`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: newRating, userId }),
    });

    if (!res.ok) return;

    const ratingData = await res.json() as Pick<AudioFile, 'ratings' | 'myRating' | 'userRating' | 'ratingUpdatedAt'>;
    const updatedFile = { ...file, ...ratingData };
    setFiles(prev => prev.map(f => f.id === file.id ? updatedFile : f));
  };

  const toggleLike = async () => {
    const res = await fetch(`/api/files/${encodeURIComponent(file.id)}/like`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ liked: !file.liked }),
    });

    if (!res.ok) return;

    const data = await res.json() as { liked: boolean; likedBy: string[] };
    setFiles(prev => prev.map(f => f.id === file.id ? { ...f, ...data } : f));
  };

  const updateFile = async (updatedFile: AudioFile) => {
    await fetch(`/api/files/${encodeURIComponent(file.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedFile),
    });
    setFiles(prev => prev.map(f => f.id === file.id ? updatedFile : f));
  };

  const saveRename = async () => {
    const nextName = renameDraft.trim();
    if (!nextName || nextName === file.name) {
      setRenameDraft(file.name);
      setIsRenaming(false);
      return;
    }

    const updatedFile = {
      ...file,
      name: nextName,
      originalName: file.originalName || file.name,
    };

    try {
      await updateFile(updatedFile);
      setRenameDraft(nextName);
      setIsRenaming(false);
    } catch {
      alert('Failed to rename file');
    }
  };

  const toggleTag = async (category: 'instruments' | 'vibes', tag: string) => {
    const instruments = getTags(file, 'instruments', 'instrument');
    const vibes = getTags(file, 'vibes', 'vibe');
    const nextInstruments = category === 'instruments'
      ? instruments.includes(tag)
        ? instruments.filter(instrument => instrument !== tag)
        : [...instruments, tag]
      : instruments;
    const nextVibes = category === 'vibes'
      ? vibes.includes(tag)
        ? vibes.filter(vibe => vibe !== tag)
        : [...vibes, tag]
      : vibes;
    const updatedFile = {
      ...file,
      instrument: nextInstruments[0] || '',
      vibe: nextVibes[0] || '',
      instruments: nextInstruments,
      vibes: nextVibes,
    };
    await updateFile(updatedFile);
  };

  const toggleCollection = async (collection: string) => {
    const trimmedCollection = collection.trim();
    if (!trimmedCollection) return;

    const collections = Array.isArray(file.collections) ? file.collections.filter(Boolean) : [];
    const nextCollections = collections.includes(trimmedCollection)
      ? collections.filter(existingCollection => existingCollection !== trimmedCollection)
      : [...collections, trimmedCollection];

    await updateCollections(nextCollections);
  };

  const addCollection = async () => {
    const trimmedCollection = newCollection.trim();
    if (!trimmedCollection) return;

    const collections = Array.isArray(file.collections) ? file.collections.filter(Boolean) : [];
    if (!collections.includes(trimmedCollection)) {
      await updateCollections([...collections, trimmedCollection]);
    }
    setNewCollection('');
    setShowNewCollectionForm(false);
  };

  const updateCollections = async (collections: string[]) => {
    const res = await fetch(`/api/files/${encodeURIComponent(file.id)}/collections`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collections }),
    });

    if (!res.ok) return;

    const data = await res.json() as { collections: string[] };
    const updatedFile = { ...file, collections: data.collections };
    setFiles(prev => prev.map(f => f.id === file.id ? updatedFile : f));
  };

  const saveNotes = async () => {
    const trimmedNote = noteText.trim();
    const updatedFile = {
      ...file,
      notes: trimmedNote ? noteText : '',
    };
    await updateFile(updatedFile);
  };

  const seekAndPlayComment = (timestamp: number) => {
    if (!wavesurferRef.current || !markerDuration) return;

    wavesurferRef.current.seekTo(Math.min(1, Math.max(0, timestamp / markerDuration)));
    setCurrentTime(timestamp);
    wavesurferRef.current.play();
  };

  const handleWaveformClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const wavesurfer = wavesurferRef.current;
    const waveformElement = waveformRef.current;
    if (!wavesurfer || !waveformElement) return;

    const hasStartedFromClick = tracksStartedFromWaveformClick.has(file.id);
    const rect = waveformElement.getBoundingClientRect();
    const progress = hasStartedFromClick
      ? Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
      : 0;

    tracksStartedFromWaveformClick.add(file.id);
    wavesurfer.seekTo(progress);
    setCurrentTime((duration || file.waveformDuration || 0) * progress);
    wavesurfer.play();
  };

  const addComment = async () => {
    const trimmedComment = newComment.trim();
    if (!trimmedComment) return;

    const rawTimestamp = usePlayheadTime ? currentTime : parseTimecode(commentTimecode);
    const maxDuration = duration || file.waveformDuration || 0;
    const timestamp = rawTimestamp !== undefined && rawTimestamp >= 0
      ? Math.min(rawTimestamp, maxDuration || rawTimestamp)
      : undefined;

    const res = await fetch(`/api/files/${encodeURIComponent(file.id)}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: trimmedComment, timestamp }),
    });

    if (!res.ok) return;

    const data = await res.json() as { comments: AudioComment[] };
    setFiles(prev => prev.map(f => f.id === file.id ? { ...f, comments: data.comments } : f));
    setNewComment('');
  };

  const deleteComment = async (commentId: string) => {
    const res = await fetch(`/api/files/${encodeURIComponent(file.id)}/comments`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commentId }),
    });

    if (!res.ok) return;

    const data = await res.json() as { comments: AudioComment[] };
    setFiles(prev => prev.map(f => f.id === file.id ? { ...f, comments: data.comments } : f));
  };

  const ensureGainNode = async () => {
    if (gainNodeRef.current) return gainNodeRef.current;
    if (!wavesurferRef.current) return null;

    const audioContext = getSharedAudioContext();
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    const mediaElement = wavesurferRef.current.getMediaElement();
    const source = audioContext.createMediaElementSource(mediaElement);
    const gainNode = audioContext.createGain();
    source.connect(gainNode);
    gainNode.connect(audioContext.destination);
    mediaSourceRef.current = source;
    gainNodeRef.current = gainNode;
    return gainNode;
  };

  const handleVolumeBoostClick = async () => {
    if (isVolumeBoosted) {
      if (gainNodeRef.current) {
        gainNodeRef.current.gain.value = 1;
      }
      setIsVolumeBoosted(false);
      setVolumeBoostConfirming(false);
      return;
    }

    if (!volumeBoostConfirming) {
      setVolumeBoostConfirming(true);
      return;
    }

    const gainNode = await ensureGainNode();
    if (!gainNode) return;
    gainNode.gain.value = VOL_BOOST_GAIN;
    setIsVolumeBoosted(true);
    setVolumeBoostConfirming(false);
  };

  const refreshWaveform = async () => {
    setWaveformRefreshing(true);
    try {
      const latestFile = latestFileRef.current;
      const res = await fetch(`/api/files/${encodeURIComponent(latestFile.id)}/audio`);
      if (!res.ok) throw new Error('Failed to load audio file');

      const audioContext = getSharedAudioContext();
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      const audioBuffer = await audioContext.decodeAudioData(await res.arrayBuffer());
      const waveformPeaks = createWaveformPeaks(audioBuffer);
      const updatedFile = {
        ...latestFile,
        waveformPeaks,
        waveformDuration: audioBuffer.duration,
      };

      const saveRes = await fetch(`/api/files/${encodeURIComponent(latestFile.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedFile),
      });
      if (!saveRes.ok) throw new Error('Failed to save waveform');

      initialWaveformCacheRef.current = {
        peaks: waveformPeaks,
        duration: audioBuffer.duration,
      };
      setDuration(audioBuffer.duration);
      setCurrentTime(0);
      setFiles(prev => prev.map(f => f.id === latestFile.id ? updatedFile : f));
      setShouldMountWaveform(true);
      setWaveformRefreshKey(prev => prev + 1);
    } catch (error) {
      console.error('Failed to refresh waveform for', latestFileRef.current.id, error);
      alert('Failed to refresh waveform');
    } finally {
      setWaveformRefreshing(false);
    }
  };

  const instruments = getTags(file, 'instruments', 'instrument');
  const vibes = getTags(file, 'vibes', 'vibe');
  const finish = file.finish || '';
  const collections = Array.isArray(file.collections) ? file.collections.filter(Boolean) : [];
  const adamRating = file.ratings?.adam || file.myRating || 0;
  const displayedAdamRating = hoveredAdamRating || adamRating;
  const currentUserRating = file.ratings?.[currentUser.id] || file.userRating || 0;
  const displayedUserRating = hoveredUserRating || currentUserRating;
  const friendRatings = accountUsers.filter(user => user.id !== 'adam' && (file.ratings?.[user.id] || 0) > 0);
  const instrumentChoices = Array.from(new Set([...instruments, ...instrumentOptions]));
  const vibeChoices = Array.from(new Set([...vibes, ...vibeOptions]));
  const collectionChoices = Array.from(new Set([...collections, ...collectionOptions]));
  const hasNotes = noteText.trim().length > 0;
  const comments = useMemo<AudioComment[]>(
    () => Array.isArray(file.comments) ? file.comments.filter(comment => comment.userId) : [],
    [file.comments]
  );
  const hasComments = comments.length > 0;
  const hasCollections = collections.length > 0;
  const colorTags = (file.colorTags || []).filter(color => FINDER_COLOR_HEX[color]);
  const durationLabel = formatDuration(duration || file.waveformDuration);
  const playheadLabel = formatDuration(currentTime) || '0:00';
  const markerDuration = duration || file.waveformDuration || 0;
  const highlightedCommentId = useMemo(() => {
    const closestComment = comments.reduce<AudioComment | null>((closest, comment) => {
      if (typeof comment.timestamp !== 'number' || comment.timestamp > currentTime) return closest;
      if (!closest || typeof closest.timestamp !== 'number' || comment.timestamp >= closest.timestamp) return comment;
      return closest;
    }, null);

    return closestComment ? closestComment.id : null;
  }, [comments, currentTime]);

  return (
    <div ref={cardRef} className="relative overflow-hidden rounded-md border border-border/70 bg-[#1d1f1d] p-3 shadow-[0_18px_50px_rgba(0,0,0,0.24)] scroll-mt-24 sm:p-4">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/35 to-transparent" />
      <div className="grid gap-4 md:grid-cols-[minmax(240px,0.82fr)_minmax(420px,1.45fr)] md:items-center">
        <div className="order-2 min-w-0 flex-1 md:order-1">
          <div className="mb-3">
            <div className="flex items-start gap-2">
              <button
                type="button"
                onClick={toggleLike}
                className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded border transition sm:mt-1 sm:h-7 sm:w-7 ${
                  file.liked
                    ? 'border-red-400/50 bg-red-400/10 text-red-400'
                    : 'border-border/60 text-muted-foreground hover:text-red-300'
                }`}
                aria-label={file.liked ? `Unlike ${file.name}` : `Like ${file.name}`}
                title={file.liked ? 'Liked' : 'Like'}
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M12 20s-7.5-4.6-9.4-9.1C1.2 7.5 3.1 4 6.6 4c2 0 3.4 1 4.2 2.2C11.6 5 13 4 15 4c3.5 0 5.4 3.5 4 6.9C17.5 15.4 12 20 12 20z"
                    fill={file.liked ? 'currentColor' : 'none'}
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <div className="min-w-0 flex-1">
                {isRenaming ? (
                  <input
                    type="text"
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onBlur={saveRename}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void saveRename();
                      if (event.key === 'Escape') {
                        setRenameDraft(file.name);
                        setIsRenaming(false);
                      }
                    }}
                    className="w-full rounded border border-accent/50 bg-background/80 px-2 py-1 text-lg font-semibold text-foreground outline-none sm:text-xl"
                    autoFocus
                  />
                ) : (
                  <div className="flex min-w-0 items-start gap-2">
                    <div className="min-w-0">
                      <h2 className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-lg font-semibold text-foreground sm:text-xl">
                        <span className="break-words">{file.name}</span>
                        {file.originalName && file.originalName !== file.name && (
                          <span className="break-all text-[11px] font-light text-muted-foreground opacity-65 sm:text-xs">
                            ({file.originalName})
                          </span>
                        )}
                      </h2>
                    </div>
                    {currentUser.isAdmin && (
                      <button
                        type="button"
                        onClick={() => {
                          setRenameDraft(file.name);
                          setIsRenaming(true);
                        }}
                        className="mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border/60 text-muted-foreground opacity-70 transition hover:border-border hover:text-foreground hover:opacity-100"
                        title="Rename file"
                        aria-label={`Rename ${file.name}`}
                      >
                        <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m16.9 4.7 2.4 2.4M4 20h4.8L20 8.8a1.7 1.7 0 0 0 0-2.4L17.6 4a1.7 1.7 0 0 0-2.4 0L4 15.2V20z" />
                        </svg>
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="mb-3 space-y-2">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                {instruments.length === 0 && (
                  <span className="text-xs font-light text-muted-foreground opacity-70">Instruments</span>
                )}
                {instruments.map(tag => (
                  <button
                    key={tag}
                    type="button"
                    className="rounded border border-border/65 bg-[#252824] px-2 py-1.5 text-xs text-muted-foreground shadow-inner shadow-black/10"
                  >
                    {displayTag(tag)}
                  </button>
                ))}
                {currentUser.isAdmin && (
                  <button
                    type="button"
                    onClick={() => setOpenTagPicker(prev => prev === 'instruments' ? null : 'instruments')}
                    className="inline-flex h-9 w-9 items-center justify-center rounded border border-border/70 bg-[#252824] text-sm text-muted-foreground transition hover:border-accent/50 hover:text-foreground sm:h-6 sm:w-6"
                    aria-label={`Add instrument tag to ${file.name}`}
                  >
                    {openTagPicker === 'instruments' ? '-' : '+'}
                  </button>
                )}
              </div>
              {currentUser.isAdmin && openTagPicker === 'instruments' && (
                <div className="mt-2 flex flex-wrap gap-2 rounded border border-border/70 bg-[#181a18] p-2">
                  {instrumentChoices.length > 0 ? instrumentChoices.map(tag => {
                    const selected = instruments.includes(tag);
                    return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => toggleTag('instruments', tag)}
                      className={`rounded border px-3 py-2 text-xs transition sm:px-2 sm:py-1 ${
                        selected
                          ? 'border-accent/50 bg-accent/15 text-accent'
                          : 'border-border bg-background text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {displayTag(tag)}
                    </button>
                    );
                  }) : (
                    <span className="text-xs text-muted-foreground">No more instrument tags</span>
                  )}
                </div>
              )}
            </div>
            <div className="border-t border-border/40 pt-2 sm:w-fit sm:min-w-48 sm:max-w-full sm:pr-8">
              <div className="flex flex-wrap items-center gap-2">
                {vibes.length === 0 && (
                  <span className="text-xs font-light text-muted-foreground opacity-70">Vibes</span>
                )}
                {vibes.map(tag => (
                  <button
                    key={tag}
                    type="button"
                    className="rounded border border-border/65 bg-[#252824] px-2 py-1.5 text-xs text-muted-foreground shadow-inner shadow-black/10"
                  >
                    {displayTag(tag)}
                  </button>
                ))}
                {currentUser.isAdmin && (
                  <button
                    type="button"
                    onClick={() => setOpenTagPicker(prev => prev === 'vibes' ? null : 'vibes')}
                    className="inline-flex h-9 w-9 items-center justify-center rounded border border-border/70 bg-[#252824] text-sm text-muted-foreground transition hover:border-accent/50 hover:text-foreground sm:h-6 sm:w-6"
                    aria-label={`Add vibe tag to ${file.name}`}
                  >
                    {openTagPicker === 'vibes' ? '-' : '+'}
                  </button>
                )}
              </div>
              {currentUser.isAdmin && openTagPicker === 'vibes' && (
                <div className="mt-2 flex flex-wrap gap-2 rounded border border-border/70 bg-[#181a18] p-2">
                  {vibeChoices.length > 0 ? vibeChoices.map(tag => {
                    const selected = vibes.includes(tag);
                    return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => toggleTag('vibes', tag)}
                      className={`rounded border px-3 py-2 text-xs transition sm:px-2 sm:py-1 ${
                        selected
                          ? 'border-accent/50 bg-accent/15 text-accent'
                          : 'border-border bg-background text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {displayTag(tag)}
                    </button>
                    );
                  }) : (
                    <span className="text-xs text-muted-foreground">No more vibe tags</span>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="mt-3 grid grid-cols-[4.75rem_auto] items-center gap-x-3 gap-y-1 rounded border border-border/35 bg-[#181a18]/70 p-2 sm:grid-cols-[4.75rem_auto]">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Adam&apos;s</span>
            <div className="flex items-center">
            {[1, 2, 3, 4, 5].map((star) => (
              currentUser.isAdmin ? (
                <button
                  key={star}
                  type="button"
                  onClick={() => handleUserRatingChange(star, 'adam')}
                  onMouseEnter={() => setHoveredAdamRating(star)}
                  onMouseLeave={() => setHoveredAdamRating(0)}
                  className={`inline-flex h-9 w-8 items-center justify-center sm:h-6 sm:w-5 ${star <= displayedAdamRating ? getRatingColor(displayedAdamRating) : 'text-muted-foreground'}`}
                  aria-label={`Set Adam's rating to ${star} stars`}
                  title={`Set Adam's rating to ${star}`}
                >
                  <StarIcon filled={star <= displayedAdamRating} />
                </button>
              ) : (
                <span
                  key={star}
                  className={`inline-flex h-9 w-8 items-center justify-center sm:h-6 sm:w-5 ${star <= adamRating ? getRatingColor(adamRating) : 'text-muted-foreground'}`}
                >
                  <StarIcon filled={star <= adamRating} />
                </span>
              )
            ))}
            </div>
            {currentUser.id !== 'adam' && (
              <>
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Your&apos;s</span>
            <div className="flex items-center">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  type="button"
                  onClick={() => handleUserRatingChange(star)}
                  onMouseEnter={() => setHoveredUserRating(star)}
                  onMouseLeave={() => setHoveredUserRating(0)}
                  className={`inline-flex h-9 w-8 items-center justify-center sm:h-6 sm:w-5 ${star <= displayedUserRating ? getRatingColor(displayedUserRating) : 'text-muted-foreground'}`}
                >
                  <StarIcon filled={star <= displayedUserRating} />
                </button>
              ))}
            </div>
              </>
            )}
            {currentUser.isAdmin && friendRatings.map(user => {
              const rating = file.ratings?.[user.id] || 0;
              return (
                <div key={user.id} className="contents">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{user.name}</span>
                  <div className="flex items-center">
                    {[1, 2, 3, 4, 5].map(star => (
                      <span
                        key={star}
                        className={`inline-flex h-9 w-8 items-center justify-center sm:h-6 sm:w-5 ${star <= rating ? getRatingColor(rating) : 'text-muted-foreground'}`}
                      >
                        <StarIcon filled={star <= rating} />
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 sm:gap-3">
            {finish && (
              <>
                <span className="text-xs font-light text-muted-foreground opacity-70">{displayTag(finish)}</span>
                <span className="text-xs font-light text-muted-foreground opacity-70">-</span>
              </>
            )}
            <span className="text-xs font-light text-muted-foreground opacity-70" title={`Recorded ${formatCreatedDate(file)}`}>
              {file.year || 'N/A'}
            </span>
            {(currentUser.isAdmin || hasNotes) && <button
              type="button"
              onClick={() => setShowNotes(prev => !prev)}
              className={`rounded border px-3 py-2 text-xs transition sm:px-2 sm:py-0.5 ${
                hasNotes
                  ? 'border-accent/40 bg-accent/10 text-accent hover:bg-accent/15'
                  : 'border-border/60 text-muted-foreground hover:border-border hover:text-foreground'
              }`}
            >
              Notes
            </button>}
            <button
              type="button"
              onClick={() => setShowComments(prev => !prev)}
              className={`rounded border px-3 py-2 text-xs transition sm:px-2 sm:py-0.5 ${
                hasComments
                  ? 'border-accent/40 bg-accent/10 text-accent hover:bg-accent/15'
                  : 'border-border/60 text-muted-foreground hover:border-border hover:text-foreground'
              }`}
            >
              Comments
            </button>
            <button
              type="button"
              onClick={() => setShowCollections(prev => !prev)}
              className={`rounded border px-3 py-2 text-xs transition sm:px-2 sm:py-0.5 ${
                hasCollections
                  ? 'border-accent/40 bg-accent/10 text-accent hover:bg-accent/15'
                  : 'border-border/60 text-muted-foreground hover:border-border hover:text-foreground'
              }`}
            >
              Collections
            </button>
            {file.stems && (
              <a
                href={`/api/files/${encodeURIComponent(file.id)}/stems`}
                download={file.stems.name}
                className="rounded border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-accent transition hover:bg-accent/15 sm:px-2 sm:py-0.5"
                title={file.stems.name}
              >
                Stems
              </a>
            )}
          </div>
          <div className="mt-3 space-y-3 md:hidden">
            {showNotes && (
              <div>
                {currentUser.isAdmin ? (
                  <textarea
                    value={noteText}
                    onChange={(event) => setNoteText(event.target.value)}
                    onBlur={saveNotes}
                    placeholder="Add notes..."
                    className="min-h-24 w-full resize-y rounded border border-border bg-background/70 p-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-accent"
                  />
                ) : (
                  <div className="min-h-16 w-full whitespace-pre-wrap rounded border border-border bg-background/50 p-3 text-sm text-muted-foreground">
                    {noteText}
                  </div>
                )}
              </div>
            )}
            {showComments && (
              <div className="rounded border border-border bg-muted/40 p-3">
                <div className="mb-3 space-y-2">
                  {comments.length > 0 ? comments.map(comment => (
                    <div
                      key={comment.id}
                      className={`rounded border p-2 text-sm transition ${
                        highlightedCommentId === comment.id
                          ? 'border-accent/60 bg-accent/10'
                          : 'border-border/60 bg-background/60'
                      }`}
                    >
                      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground" title={formatCommentDate(comment.createdAt)}>{comment.userName}</span>
                        {typeof comment.timestamp === 'number' && (
                          <button
                            type="button"
                            onClick={() => {
                              if (typeof comment.timestamp === 'number') {
                                seekAndPlayComment(comment.timestamp);
                              }
                            }}
                            className="text-accent hover:underline"
                          >
                            @{formatDuration(comment.timestamp)}
                          </button>
                        )}
                        {comment.userId === currentUser.id && (
                          <button
                            type="button"
                            onClick={() => deleteComment(comment.id)}
                            className="ml-auto text-muted-foreground hover:text-red-400"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                      <p className="whitespace-pre-wrap text-muted-foreground">{comment.text}</p>
                    </div>
                  )) : (
                    <p className="text-sm text-muted-foreground">No comments yet</p>
                  )}
                </div>
                <textarea
                  value={newComment}
                  onChange={(event) => setNewComment(event.target.value)}
                  placeholder="Add a comment..."
                  className="mb-2 min-h-20 w-full resize-y rounded border border-border bg-background/70 p-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-accent"
                />
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={usePlayheadTime}
                      onChange={(event) => setUsePlayheadTime(event.target.checked)}
                      className="h-3.5 w-3.5 accent-accent"
                    />
                    At playhead ({playheadLabel})
                  </label>
                  {!usePlayheadTime && (
                    <input
                      type="text"
                      value={commentTimecode}
                      onChange={(event) => setCommentTimecode(event.target.value)}
                      placeholder="1:23"
                      className="min-h-9 w-28 rounded border border-border bg-background/70 px-2 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-accent sm:w-24 sm:text-xs"
                    />
                  )}
                  <button
                    type="button"
                    onClick={addComment}
                    disabled={!newComment.trim()}
                    className="rounded bg-accent px-3 py-2 text-xs text-accent-foreground transition hover:bg-accent/90 disabled:opacity-50"
                  >
                    Add Comment
                  </button>
                </div>
              </div>
            )}
            {showCollections && (
              <div className="rounded border border-border bg-muted/40 p-3">
                <div className="mb-3 flex flex-wrap gap-2">
                  {collectionChoices.length > 0 ? collectionChoices.map(collection => {
                    const selected = collections.includes(collection);
                    return (
                      <button
                        key={collection}
                        type="button"
                        onClick={() => toggleCollection(collection)}
                        className={`rounded border px-3 py-2 text-xs transition sm:px-2 sm:py-1 ${
                          selected
                            ? 'border-accent/50 bg-accent/15 text-accent'
                            : 'border-border bg-background text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {displayTag(collection)}
                      </button>
                    );
                  }) : (
                    <span className="text-xs text-muted-foreground">No collections yet</span>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowNewCollectionForm(prev => !prev)}
                    className={`rounded border px-3 py-2 text-xs transition sm:px-2 sm:py-1 ${
                      showNewCollectionForm
                        ? 'border-accent/50 bg-accent/15 text-accent'
                        : 'border-border bg-background text-muted-foreground hover:text-foreground'
                    }`}
                    aria-label={showNewCollectionForm ? 'Hide new collection form' : 'Add new collection'}
                  >
                    {showNewCollectionForm ? '-' : '+'}
                  </button>
                </div>
                {showNewCollectionForm && (
                  <div className="flex max-w-md">
                    <input
                      type="text"
                      value={newCollection}
                      onChange={(event) => setNewCollection(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') addCollection();
                      }}
                      placeholder="New collection"
                      className="min-w-0 flex-1 rounded-l border border-border bg-background/70 p-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-accent sm:p-2"
                    />
                    <button
                      type="button"
                      onClick={addCollection}
                      className="rounded-r bg-accent px-3 py-2 text-sm text-accent-foreground transition hover:bg-accent/90"
                    >
                      Add
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="order-1 relative flex min-h-56 min-w-0 items-center justify-center rounded border border-border/35 bg-[#171917] px-2 shadow-inner shadow-black/20 sm:min-h-48 md:order-2">
          <div className="absolute right-0 top-0 z-10 flex items-start gap-1">
            <button
              type="button"
              onClick={refreshWaveform}
              disabled={waveformRefreshing}
              className="inline-flex h-8 w-8 items-center justify-center rounded border border-border/60 bg-background/80 text-muted-foreground opacity-55 shadow-sm backdrop-blur transition hover:border-accent/50 hover:text-foreground hover:opacity-85 disabled:opacity-35"
              title="Refresh waveform"
              aria-label={`Refresh waveform for ${file.name}`}
            >
              <svg className={`h-3.5 w-3.5 ${waveformRefreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 11a8.1 8.1 0 0 0-15.5-2M4 5v4h4m-4 4a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" />
              </svg>
            </button>
            <button
              type="button"
              onClick={handleVolumeBoostClick}
              className={`min-h-8 rounded border px-2 py-1 text-[10px] font-medium leading-none opacity-50 transition hover:opacity-80 ${
                isVolumeBoosted
                  ? 'border-accent/50 bg-accent/15 text-accent'
                  : volumeBoostConfirming
                    ? 'border-accent/40 bg-accent/10 text-accent'
                    : 'border-border/60 bg-background/80 text-muted-foreground hover:border-accent/50 hover:text-foreground'
              }`}
              title={`Boost this song by ${VOL_BOOST_DB} dB`}
            >
              {isVolumeBoosted ? `+${VOL_BOOST_DB} dB` : volumeBoostConfirming ? 'Confirm' : 'Vol Boost'}
            </button>
          </div>
          <div 
            ref={waveformRef} 
            className="mx-auto mb-2 min-h-56 w-full max-w-[820px] cursor-pointer sm:min-h-44" 
            onClick={handleWaveformClick}
          >
            {!shouldRenderWaveform && (
              <div className="flex h-56 w-full items-center justify-center rounded border border-border/40 bg-muted/20 text-xs text-muted-foreground sm:h-44">
                Waveform loads on scroll
              </div>
            )}
          </div>
          {durationLabel && (
            <span className="absolute bottom-2 right-1 rounded bg-background/70 px-2 py-1 text-sm font-light text-muted-foreground opacity-80 sm:py-0.5 sm:text-xs">
              {playheadLabel}/{durationLabel}
            </span>
          )}
          {markerDuration > 0 && comments.some(comment => typeof comment.timestamp === 'number') && (
            <div className="pointer-events-none absolute inset-x-0 top-1/2 z-20 mx-auto h-56 max-w-[760px] -translate-y-1/2 sm:h-44">
              {comments.filter(comment => typeof comment.timestamp === 'number').map(comment => (
                <button
                  key={comment.id}
                  type="button"
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setShowComments(true);
                    if (typeof comment.timestamp === 'number') {
                      seekAndPlayComment(comment.timestamp);
                    }
                  }}
                  className="group pointer-events-auto absolute bottom-2 flex h-[88%] w-7 -translate-x-1/2 items-end justify-center rounded-sm transition hover:bg-accent/10 sm:w-5"
                  style={{ left: `${Math.min(100, Math.max(0, ((comment.timestamp || 0) / markerDuration) * 100))}%` }}
                  title={`${comment.userName}: ${comment.text}`}
                  aria-label={`Open comment from ${comment.userName}`}
                >
                  <span className="absolute bottom-0 top-2 w-px rounded-full bg-accent/45" />
                  <span className="relative h-3.5 w-3.5 rounded-full border border-background/80 bg-accent/80 shadow-sm transition group-hover:bg-accent" />
                </button>
              ))}
            </div>
          )}
        </div>
        {showNotes && (
          <div className="hidden md:order-3 md:col-span-2 md:block">
            {currentUser.isAdmin ? (
              <textarea
                value={noteText}
                onChange={(event) => setNoteText(event.target.value)}
                onBlur={saveNotes}
                placeholder="Add notes..."
                className="min-h-24 w-full resize-y rounded border border-border bg-background/70 p-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-accent"
              />
            ) : (
              <div className="min-h-16 w-full whitespace-pre-wrap rounded border border-border bg-background/50 p-3 text-sm text-muted-foreground">
                {noteText}
              </div>
            )}
          </div>
        )}
        {showComments && (
          <div className="hidden rounded border border-border bg-muted/40 p-3 md:order-3 md:col-span-2 md:block">
            <div className="mb-3 space-y-2">
              {comments.length > 0 ? comments.map(comment => (
                <div
                  key={comment.id}
                  className={`rounded border p-2 text-sm transition ${
                    highlightedCommentId === comment.id
                      ? 'border-accent/60 bg-accent/10'
                      : 'border-border/60 bg-background/60'
                  }`}
                >
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground" title={formatCommentDate(comment.createdAt)}>{comment.userName}</span>
                    {typeof comment.timestamp === 'number' && (
                      <button
                        type="button"
                        onClick={() => {
                          if (typeof comment.timestamp === 'number') {
                            seekAndPlayComment(comment.timestamp);
                          }
                        }}
                        className="text-accent hover:underline"
                      >
                        @{formatDuration(comment.timestamp)}
                      </button>
                    )}
                    {comment.userId === currentUser.id && (
                      <button
                        type="button"
                        onClick={() => deleteComment(comment.id)}
                        className="ml-auto text-muted-foreground hover:text-red-400"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                  <p className="whitespace-pre-wrap text-muted-foreground">{comment.text}</p>
                </div>
              )) : (
                <p className="text-sm text-muted-foreground">No comments yet</p>
              )}
            </div>
            <textarea
              value={newComment}
              onChange={(event) => setNewComment(event.target.value)}
              placeholder="Add a comment..."
              className="mb-2 min-h-20 w-full resize-y rounded border border-border bg-background/70 p-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-accent"
            />
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={usePlayheadTime}
                  onChange={(event) => setUsePlayheadTime(event.target.checked)}
                  className="h-3.5 w-3.5 accent-accent"
                />
                At playhead ({playheadLabel})
              </label>
              {!usePlayheadTime && (
                <input
                  type="text"
                  value={commentTimecode}
                  onChange={(event) => setCommentTimecode(event.target.value)}
                  placeholder="1:23"
                  className="min-h-9 w-28 rounded border border-border bg-background/70 px-2 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-accent sm:w-24 sm:text-xs"
                />
              )}
              <button
                type="button"
                onClick={addComment}
                disabled={!newComment.trim()}
                className="rounded bg-accent px-3 py-2 text-xs text-accent-foreground transition hover:bg-accent/90 disabled:opacity-50"
              >
                Add Comment
              </button>
            </div>
          </div>
        )}
        {showCollections && (
          <div className="hidden rounded border border-border bg-muted/40 p-3 md:order-3 md:col-span-2 md:block">
            <div className="mb-3 flex flex-wrap gap-2">
              {collectionChoices.length > 0 ? collectionChoices.map(collection => {
                const selected = collections.includes(collection);
                return (
                  <button
                    key={collection}
                    type="button"
                    onClick={() => toggleCollection(collection)}
                    className={`rounded border px-3 py-2 text-xs transition sm:px-2 sm:py-1 ${
                      selected
                        ? 'border-accent/50 bg-accent/15 text-accent'
                        : 'border-border bg-background text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {displayTag(collection)}
                  </button>
                );
              }) : (
                <span className="text-xs text-muted-foreground">No collections yet</span>
              )}
              <button
                type="button"
                onClick={() => setShowNewCollectionForm(prev => !prev)}
                className={`rounded border px-3 py-2 text-xs transition sm:px-2 sm:py-1 ${
                  showNewCollectionForm
                    ? 'border-accent/50 bg-accent/15 text-accent'
                    : 'border-border bg-background text-muted-foreground hover:text-foreground'
                }`}
                aria-label={showNewCollectionForm ? 'Hide new collection form' : 'Add new collection'}
              >
                {showNewCollectionForm ? '-' : '+'}
              </button>
            </div>
            {showNewCollectionForm && (
              <div className="flex max-w-md">
                <input
                  type="text"
                  value={newCollection}
                  onChange={(event) => setNewCollection(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') addCollection();
                  }}
                  placeholder="New collection"
                  className="min-w-0 flex-1 rounded-l border border-border bg-background/70 p-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-accent sm:p-2"
                />
                <button
                  type="button"
                  onClick={addCollection}
                  className="rounded-r bg-accent px-3 py-2 text-sm text-accent-foreground transition hover:bg-accent/90"
                >
                  Add
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      {colorTags.length > 0 && (
        <div className="absolute bottom-3 right-3 z-10 flex flex-row-reverse" title={`Finder tags: ${colorTags.join(', ')}`}>
          {colorTags.map(color => (
            <span
              key={color}
              className="-ml-1 h-3.5 w-3.5 rounded-full border border-background/80 shadow-sm"
              style={{ backgroundColor: FINDER_COLOR_HEX[color] }}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default function Home() {
  const [files, setFiles] = useState<AudioFile[]>([]);
  const [currentUser, setCurrentUser] = useState<ArchiveUser | null>(null);
  const [accountUsers, setAccountUsers] = useState<ArchiveUser[]>([]);
  const [selectedInstruments, setSelectedInstruments] = useState<string[]>([]);
  const [selectedVibes, setSelectedVibes] = useState<string[]>([]);
  const [selectedFinishes, setSelectedFinishes] = useState<string[]>(['Tracked', 'Recorder']);
  const [selectedCollections, setSelectedCollections] = useState<string[]>([]);
  const [selectedYears, setSelectedYears] = useState<number[]>([]);
  const [selectedAdamRatings, setSelectedAdamRatings] = useState<number[]>([]);
  const [excludedInstruments, setExcludedInstruments] = useState<string[]>([]);
  const [excludedVibes, setExcludedVibes] = useState<string[]>([]);
  const [excludedFinishes, setExcludedFinishes] = useState<string[]>([]);
  const [excludedCollections, setExcludedCollections] = useState<string[]>([]);
  const [excludedYears, setExcludedYears] = useState<number[]>([]);
  const [excludedAdamRatings, setExcludedAdamRatings] = useState<number[]>([]);
  const [likedOnly, setLikedOnly] = useState(false);
  const [untaggedOnly, setUntaggedOnly] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchNotes, setSearchNotes] = useState(false);
  const [collapsedFilters, setCollapsedFilters] = useState({
    instruments: true,
    vibes: true,
    finish: true,
    collections: true,
    years: true,
    adamsRatings: true,
  });
  const [instrumentOptions, setInstrumentOptions] = useState<string[]>(DEFAULT_INSTRUMENTS);
  const [vibeOptions, setVibeOptions] = useState<string[]>(DEFAULT_VIBES);
  const [newInstrument, setNewInstrument] = useState('');
  const [newVibe, setNewVibe] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('adamsRatingRandom');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [randomSortSeed, setRandomSortSeed] = useState(() => Math.random());
  const [randomTrackIds, setRandomTrackIds] = useState<string[] | null>(null);
  const [randomIncludeVoiceMemos, setRandomIncludeVoiceMemos] = useState(false);
  const [activeTrack, setActiveTrack] = useState<AudioFile | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [endMode, setEndMode] = useState<EndMode>('stop');
  const [renderWindow, setRenderWindow] = useState({ key: '', limit: INITIAL_RENDER_LIMIT });
  const [activityTargetTrackId, setActivityTargetTrackId] = useState<string | null>(null);
  const urlTargetTrackId = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('track');
  const targetTrackId = activityTargetTrackId || urlTargetTrackId;
  const activeWaveSurferRef = useRef<WaveSurfer | null>(null);
  const activeTrackIdRef = useRef<string | null>(null);
  const activeCardElementRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const endModeRef = useRef<EndMode>('stop');
  const playerRegistryRef = useRef<Map<string, PlayerRegistryEntry>>(new Map());
  const renderedFilesRef = useRef<AudioFile[]>([]);

  useEffect(() => {
    fetch('/api/session')
      .then(res => res.json())
      .then((data: { user: ArchiveUser | null; users: ArchiveUser[] }) => {
        setCurrentUser(data.user);
        setAccountUsers(data.users);
      });

    fetch('/api/files')
      .then(res => res.json())
      .then((data: AudioFile[]) => {
        const normalizedFiles = data.map(f => ({ ...f, year: f.year || new Date().getFullYear() }));
        setFiles(normalizedFiles);
        setInstrumentOptions(prev => Array.from(new Set([...prev, ...normalizedFiles.flatMap(file => getTags(file, 'instruments', 'instrument'))])));
        setVibeOptions(prev => Array.from(new Set([...prev, ...normalizedFiles.flatMap(file => getTags(file, 'vibes', 'vibe'))])));
      });
  }, []);

  const logout = async () => {
    await fetch('/api/session', { method: 'DELETE' });
    window.location.href = '/login';
  };

  const compareFiles = useCallback((a: AudioFile, b: AudioFile) => {
    let aVal: string | number;
    let bVal: string | number;
    switch (sortBy) {
      case 'name':
        aVal = a.name.toLowerCase();
        bVal = b.name.toLowerCase();
        break;
      case 'date':
        aVal = getCreatedDateValue(a);
        bVal = getCreatedDateValue(b);
        break;
      case 'uploadDate':
        aVal = getUploadedDateValue(a);
        bVal = getUploadedDateValue(b);
        break;
      case 'adamsRating':
      case 'adamsRatingRandom':
        aVal = a.myRating;
        bVal = b.myRating;
        break;
      case 'userRating':
        aVal = a.userRating;
        bVal = b.userRating;
        break;
      case 'random':
        aVal = getRandomSortValue(a.id, randomSortSeed);
        bVal = getRandomSortValue(b.id, randomSortSeed);
        break;
      default:
        return 0;
    }
    if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
    if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
    if (sortBy === 'adamsRatingRandom') {
      const aRandom = getRandomSortValue(a.id, randomSortSeed);
      const bRandom = getRandomSortValue(b.id, randomSortSeed);
      if (aRandom < bRandom) return -1;
      if (aRandom > bRandom) return 1;
    }
    return compareByName(a, b);
  }, [randomSortSeed, sortBy, sortDirection]);

  const matchesFilters = useCallback((file: AudioFile) => {
    const normalizedSearch = searchQuery.trim().toLowerCase();
    const instruments = getTags(file, 'instruments', 'instrument');
    const vibes = getTags(file, 'vibes', 'vibe');
    const fileCollections = Array.isArray(file.collections) ? file.collections.filter(Boolean) : [];
    const fileYear = file.year || 0;
    const adamRating = getAdamRating(file);
    const matchesSearch = normalizedSearch.length === 0
      || file.name.toLowerCase().includes(normalizedSearch)
      || (searchNotes && getNoteText(file).toLowerCase().includes(normalizedSearch));

    return (
      matchesSearch &&
      (!likedOnly || Boolean(file.liked)) &&
      (!untaggedOnly || isUntaggedFile(file)) &&
      (selectedInstruments.length === 0 || hasAny(instruments, selectedInstruments)) &&
      !hasAny(instruments, excludedInstruments) &&
      (selectedVibes.length === 0 || hasAny(vibes, selectedVibes)) &&
      !hasAny(vibes, excludedVibes) &&
      (selectedFinishes.length === 0 || (file.finish ? selectedFinishes.includes(file.finish) : false)) &&
      (!file.finish || !excludedFinishes.includes(file.finish)) &&
      (selectedCollections.length === 0 || fileCollections.some(collection => selectedCollections.includes(collection))) &&
      !hasAny(fileCollections, excludedCollections) &&
      (selectedYears.length === 0 || selectedYears.includes(fileYear)) &&
      !excludedYears.includes(fileYear) &&
      (selectedAdamRatings.length === 0 || selectedAdamRatings.includes(adamRating)) &&
      !excludedAdamRatings.includes(adamRating)
    );
  }, [excludedAdamRatings, excludedCollections, excludedFinishes, excludedInstruments, excludedVibes, excludedYears, likedOnly, searchNotes, searchQuery, selectedAdamRatings, selectedCollections, selectedFinishes, selectedInstruments, selectedVibes, selectedYears, untaggedOnly]);

  const matchesFiltersExcept = useCallback((file: AudioFile, except: FilterCategory) => {
    const normalizedSearch = searchQuery.trim().toLowerCase();
    const instruments = getTags(file, 'instruments', 'instrument');
    const vibes = getTags(file, 'vibes', 'vibe');
    const fileCollections = Array.isArray(file.collections) ? file.collections.filter(Boolean) : [];
    const fileYear = file.year || 0;
    const adamRating = getAdamRating(file);
    const matchesSearch = normalizedSearch.length === 0
      || file.name.toLowerCase().includes(normalizedSearch)
      || (searchNotes && getNoteText(file).toLowerCase().includes(normalizedSearch));

    return (
      matchesSearch &&
      (!likedOnly || Boolean(file.liked)) &&
      (!untaggedOnly || isUntaggedFile(file)) &&
      (except === 'instruments' || ((selectedInstruments.length === 0 || hasAny(instruments, selectedInstruments)) && !hasAny(instruments, excludedInstruments))) &&
      (except === 'vibes' || ((selectedVibes.length === 0 || hasAny(vibes, selectedVibes)) && !hasAny(vibes, excludedVibes))) &&
      (except === 'finish' || ((selectedFinishes.length === 0 || (file.finish ? selectedFinishes.includes(file.finish) : false)) && (!file.finish || !excludedFinishes.includes(file.finish)))) &&
      (except === 'collections' || ((selectedCollections.length === 0 || fileCollections.some(collection => selectedCollections.includes(collection))) && !hasAny(fileCollections, excludedCollections))) &&
      (except === 'years' || ((selectedYears.length === 0 || selectedYears.includes(fileYear)) && !excludedYears.includes(fileYear))) &&
      (except === 'adamsRatings' || ((selectedAdamRatings.length === 0 || selectedAdamRatings.includes(adamRating)) && !excludedAdamRatings.includes(adamRating)))
    );
  }, [excludedAdamRatings, excludedCollections, excludedFinishes, excludedInstruments, excludedVibes, excludedYears, likedOnly, searchNotes, searchQuery, selectedAdamRatings, selectedCollections, selectedFinishes, selectedInstruments, selectedVibes, selectedYears, untaggedOnly]);

  const matchesRandomFilters = useCallback((file: AudioFile) => {
    const normalizedSearch = searchQuery.trim().toLowerCase();
    const instruments = getTags(file, 'instruments', 'instrument');
    const vibes = getTags(file, 'vibes', 'vibe');
    const fileCollections = Array.isArray(file.collections) ? file.collections.filter(Boolean) : [];
    const fileYear = file.year || 0;
    const adamRating = getAdamRating(file);
    const matchesSearch = normalizedSearch.length === 0
      || file.name.toLowerCase().includes(normalizedSearch)
      || (searchNotes && getNoteText(file).toLowerCase().includes(normalizedSearch));
    const finish = file.finish || '';

    return (
      matchesSearch &&
      (!likedOnly || Boolean(file.liked)) &&
      (!untaggedOnly || isUntaggedFile(file)) &&
      (randomIncludeVoiceMemos || finish !== 'Voice Memo') &&
      (selectedInstruments.length === 0 || hasAny(instruments, selectedInstruments)) &&
      !hasAny(instruments, excludedInstruments) &&
      (selectedVibes.length === 0 || hasAny(vibes, selectedVibes)) &&
      !hasAny(vibes, excludedVibes) &&
      (selectedFinishes.length === 0 || (file.finish ? selectedFinishes.includes(file.finish) : false)) &&
      (!file.finish || !excludedFinishes.includes(file.finish)) &&
      (selectedCollections.length === 0 || fileCollections.some(collection => selectedCollections.includes(collection))) &&
      !hasAny(fileCollections, excludedCollections) &&
      (selectedYears.length === 0 || selectedYears.includes(fileYear)) &&
      !excludedYears.includes(fileYear) &&
      (selectedAdamRatings.length === 0 || selectedAdamRatings.includes(adamRating)) &&
      !excludedAdamRatings.includes(adamRating)
    );
  }, [excludedAdamRatings, excludedCollections, excludedFinishes, excludedInstruments, excludedVibes, excludedYears, likedOnly, randomIncludeVoiceMemos, searchNotes, searchQuery, selectedAdamRatings, selectedCollections, selectedFinishes, selectedInstruments, selectedVibes, selectedYears, untaggedOnly]);

  const sortedFilteredFiles = useMemo(() => {
    return files.filter(matchesFilters).sort(compareFiles);
  }, [compareFiles, files, matchesFilters]);

  const randomCandidates = useMemo(() => {
    return files.filter(matchesRandomFilters);
  }, [files, matchesRandomFilters]);

  const filteredFiles = useMemo(() => {
    if (!randomTrackIds) return sortedFilteredFiles;

    const fileById = new Map(files.map(file => [file.id, file]));
    return randomTrackIds.flatMap(id => {
      const file = fileById.get(id);
      return file && matchesRandomFilters(file) ? [file] : [];
    });
  }, [files, matchesRandomFilters, randomTrackIds, sortedFilteredFiles]);

  const filterKey = useMemo(() => JSON.stringify({
    searchNotes,
    searchQuery,
    selectedCollections,
    selectedFinishes,
    selectedInstruments,
    selectedVibes,
    selectedYears,
    selectedAdamRatings,
    excludedCollections,
    excludedFinishes,
    excludedInstruments,
    excludedVibes,
    excludedYears,
    excludedAdamRatings,
    likedOnly,
    untaggedOnly,
    randomTrackIds,
    randomSortSeed,
    sortBy,
    sortDirection,
  }), [excludedAdamRatings, excludedCollections, excludedFinishes, excludedInstruments, excludedVibes, excludedYears, likedOnly, randomSortSeed, randomTrackIds, searchNotes, searchQuery, selectedAdamRatings, selectedCollections, selectedFinishes, selectedInstruments, selectedVibes, selectedYears, sortBy, sortDirection, untaggedOnly]);

  const renderLimit = renderWindow.key === filterKey ? renderWindow.limit : INITIAL_RENDER_LIMIT;

  const visibleFileIds = useMemo(() => new Set(filteredFiles.map(file => file.id)), [filteredFiles]);

  const renderedFiles = useMemo(() => {
    if (!activeTrack || visibleFileIds.has(activeTrack.id)) {
      return filteredFiles;
    }

    const activeFile = files.find(file => file.id === activeTrack.id) || activeTrack;
    return [...filteredFiles, activeFile].sort(compareFiles);
  }, [activeTrack, compareFiles, files, filteredFiles, visibleFileIds]);

  const targetTrackIndex = targetTrackId ? renderedFiles.findIndex(file => file.id === targetTrackId) : -1;
  const effectiveRenderLimit = targetTrackIndex >= renderLimit
    ? Math.min(renderedFiles.length, targetTrackIndex + RENDER_BATCH_SIZE)
    : renderLimit;

  const displayedFiles = useMemo(() => {
    const initialFiles = renderedFiles.slice(0, effectiveRenderLimit);
    if (!activeTrack || initialFiles.some(file => file.id === activeTrack.id)) {
      return initialFiles;
    }

    const activeFile = renderedFiles.find(file => file.id === activeTrack.id);
    return activeFile ? [...initialFiles, activeFile] : initialFiles;
  }, [activeTrack, effectiveRenderLimit, renderedFiles]);

  const hasMoreFiles = effectiveRenderLimit < renderedFiles.length;

  const yearOptions = Array.from(new Set(files.map(f => f.year || 0))).sort((a, b) => b - a);
  const adamRatingOptions = [5, 4, 3, 2, 1, 0];
  const finishOptions = Array.from(new Set([...FINISH_OPTIONS, ...files.map(file => file.finish || '').filter(Boolean)]));
  const collectionOptions = Array.from(new Set(files.flatMap(file => Array.isArray(file.collections) ? file.collections.filter(Boolean) : []))).sort((a, b) => a.localeCompare(b));

  const activityEntries = useMemo<ActivityEntry[]>(() => {
    if (!currentUser?.isAdmin) return [];

    const userNameById = new Map(accountUsers.map(user => [user.id, user.name]));
    const commentActivities = files.flatMap(file => (
      (Array.isArray(file.comments) ? file.comments : [])
        .filter(comment => comment.userId && comment.userId !== 'adam' && comment.text)
        .map(comment => {
          const timestamp = new Date(comment.createdAt).getTime();
          return {
            id: `comment-${file.id}-${comment.id}`,
            type: 'comment' as const,
            file,
            userName: comment.userName || userNameById.get(comment.userId) || comment.userId,
            text: comment.timestamp !== undefined
              ? `commented at @${formatDuration(comment.timestamp)}: ${comment.text}`
              : `commented: ${comment.text}`,
            createdAt: comment.createdAt,
            sortTime: Number.isNaN(timestamp) ? 0 : timestamp,
          };
        })
    ));

    const ratingActivities = files.flatMap(file => (
      Object.entries(file.ratings || {})
        .filter(([userId, rating]) => userId !== 'adam' && (rating || 0) > 0)
        .map(([userId, rating]) => {
          const createdAt = file.ratingUpdatedAt?.[userId];
          const timestamp = createdAt ? new Date(createdAt).getTime() : 0;
          return {
            id: `rating-${file.id}-${userId}`,
            type: 'rating' as const,
            file,
            userName: userNameById.get(userId) || userId,
            text: 'rated',
            rating,
            createdAt,
            sortTime: Number.isNaN(timestamp) ? 0 : timestamp,
          };
        })
    ));

    return [...commentActivities, ...ratingActivities]
      .sort((a, b) => {
        if (a.sortTime !== b.sortTime) return b.sortTime - a.sortTime;
        if (a.type !== b.type) return a.type === 'comment' ? -1 : 1;
        return compareByName(a.file, b.file);
      });
  }, [accountUsers, currentUser?.isAdmin, files]);

  const filterCounts = useMemo(() => {
    const counts = {
      instruments: new Map<string, number>(),
      vibes: new Map<string, number>(),
      collections: new Map<string, number>(),
      finish: new Map<string, number>(),
      years: new Map<number, number>(),
      adamsRatings: new Map<number, number>(),
    };

    const increment = <T,>(map: Map<T, number>, value: T) => {
      map.set(value, (map.get(value) || 0) + 1);
    };

    files.forEach(file => {
      if (matchesFiltersExcept(file, 'instruments')) {
        new Set(getTags(file, 'instruments', 'instrument')).forEach(tag => increment(counts.instruments, tag));
      }
      if (matchesFiltersExcept(file, 'vibes')) {
        new Set(getTags(file, 'vibes', 'vibe')).forEach(tag => increment(counts.vibes, tag));
      }
      if (matchesFiltersExcept(file, 'collections')) {
        new Set(Array.isArray(file.collections) ? file.collections.filter(Boolean) : []).forEach(collection => increment(counts.collections, collection));
      }
      if (matchesFiltersExcept(file, 'finish') && file.finish) {
        increment(counts.finish, file.finish);
      }
      if (matchesFiltersExcept(file, 'years')) {
        increment(counts.years, file.year || 0);
      }
      if (matchesFiltersExcept(file, 'adamsRatings')) {
        increment(counts.adamsRatings, getAdamRating(file));
      }
    });

    return counts;
  }, [files, matchesFiltersExcept]);

  const addInstrument = () => {
    if (newInstrument.trim() && !instrumentOptions.includes(newInstrument.trim())) {
      setInstrumentOptions([...instrumentOptions, newInstrument.trim()]);
      setNewInstrument('');
    }
  };

  const addVibe = () => {
    if (newVibe.trim() && !vibeOptions.includes(newVibe.trim())) {
      setVibeOptions([...vibeOptions, newVibe.trim()]);
      setNewVibe('');
    }
  };

  const pickRandomTracks = () => {
    if (activeWaveSurferRef.current) {
      activeWaveSurferRef.current.pause();
      activeWaveSurferRef.current.seekTo(0);
    }
    activeWaveSurferRef.current = null;
    activeTrackIdRef.current = null;
    activeCardElementRef.current = null;
    setActiveTrack(null);
    setIsPlaying(false);
    setProgress(0);

    const shuffled = [...randomCandidates];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    setSortBy('random');
    setRandomSortSeed(Math.random());
    setRandomTrackIds(shuffled.slice(0, 5).map(file => file.id));
    setRenderWindow(prev => ({ ...prev, key: '', limit: INITIAL_RENDER_LIMIT }));
  };

  useEffect(() => {
    const loadMoreElement = loadMoreRef.current;
    if (!loadMoreElement || !hasMoreFiles) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setRenderWindow(prev => {
            const currentLimit = prev.key === filterKey ? prev.limit : INITIAL_RENDER_LIMIT;
            return {
              key: filterKey,
              limit: Math.min(currentLimit + RENDER_BATCH_SIZE, renderedFiles.length),
            };
          });
        }
      },
      { rootMargin: '600px 0px' }
    );

    observer.observe(loadMoreElement);
    return () => observer.disconnect();
  }, [filterKey, hasMoreFiles, renderedFiles.length]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        const target = e.target as HTMLElement | null;
        const isTyping =
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement ||
          target?.isContentEditable;

        if (isTyping) return;

        e.preventDefault();
        if (activeWaveSurferRef.current) {
          if (activeWaveSurferRef.current.isPlaying()) {
            activeWaveSurferRef.current.pause();
          } else {
            activeWaveSurferRef.current.play();
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (!activeTrack) return;

    const interval = setInterval(() => {
      const ws = activeWaveSurferRef.current;
      if (!ws) {
        setProgress(0);
        setIsPlaying(false);
        return;
      }

      const duration = ws.getDuration();
      const currentTime = ws.getCurrentTime();
      setProgress(duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0);
      setIsPlaying(ws.isPlaying());
    }, 200);

    return () => clearInterval(interval);
  }, [activeTrack]);

  useEffect(() => {
    endModeRef.current = endMode;
  }, [endMode]);

  useEffect(() => {
    renderedFilesRef.current = displayedFiles;
  }, [displayedFiles]);

  const handleCardReady = useCallback((file: AudioFile, cardElement: HTMLDivElement, wavesurfer: WaveSurfer) => {
    playerRegistryRef.current.set(file.id, { cardElement, wavesurfer });
  }, []);

  const handleCardPlay = useCallback((file: AudioFile, _cardElement: HTMLDivElement, wavesurfer: WaveSurfer) => {
    if (activeWaveSurferRef.current && activeWaveSurferRef.current !== wavesurfer) {
      activeWaveSurferRef.current.pause();
    }
    activeWaveSurferRef.current = wavesurfer;
    activeTrackIdRef.current = file.id;
    activeCardElementRef.current = _cardElement;
    setActiveTrack(file);
    setIsPlaying(true);
  }, []);

  const handleCardPause = useCallback((file: AudioFile, wavesurfer: WaveSurfer) => {
    if (activeTrackIdRef.current === file.id && activeWaveSurferRef.current === wavesurfer) {
      setIsPlaying(false);
    }
  }, []);

  const handleCardStop = useCallback((file: AudioFile, wavesurfer: WaveSurfer) => {
    if (endModeRef.current === 'repeat' && activeTrackIdRef.current === file.id && activeWaveSurferRef.current === wavesurfer) {
      wavesurfer.play();
      return;
    }

    if (endModeRef.current === 'next' && activeTrackIdRef.current === file.id && activeWaveSurferRef.current === wavesurfer) {
      const currentList = renderedFilesRef.current;
      const currentIndex = currentList.findIndex(track => track.id === file.id);
      const nextTrack = currentIndex >= 0 ? currentList[currentIndex + 1] : undefined;
      const nextPlayer = nextTrack ? playerRegistryRef.current.get(nextTrack.id) : undefined;

      if (nextTrack && nextPlayer) {
        nextPlayer.wavesurfer.play();
        return;
      }
    }

    if (activeTrackIdRef.current === file.id && activeWaveSurferRef.current === wavesurfer) {
      activeWaveSurferRef.current = null;
      activeTrackIdRef.current = null;
      activeCardElementRef.current = null;
      setActiveTrack(null);
      setIsPlaying(false);
      setProgress(0);
    }
  }, []);

  const clearActivePlayer = useCallback((file: AudioFile, wavesurfer: WaveSurfer) => {
    const registeredPlayer = playerRegistryRef.current.get(file.id);
    if (registeredPlayer?.wavesurfer === wavesurfer) {
      playerRegistryRef.current.delete(file.id);
    }

    if (activeTrackIdRef.current === file.id && activeWaveSurferRef.current === wavesurfer) {
      activeWaveSurferRef.current = null;
      activeTrackIdRef.current = null;
      activeCardElementRef.current = null;
      setActiveTrack(null);
      setIsPlaying(false);
      setProgress(0);
    }
  }, []);

  const toggleMiniPlayer = useCallback(() => {
    const wavesurfer = activeWaveSurferRef.current;
    if (!wavesurfer) return;

    if (wavesurfer.isPlaying()) {
      wavesurfer.pause();
    } else {
      wavesurfer.play();
    }
  }, []);

  const seekMiniPlayer = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const wavesurfer = activeWaveSurferRef.current;
    if (!wavesurfer) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const progress = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    wavesurfer.seekTo(progress);
    setProgress(progress * 100);
  }, []);

  const scrollToActiveCard = useCallback(() => {
    if (!activeTrack) return;

    const activeInstruments = getTags(activeTrack, 'instruments', 'instrument');
    const activeVibes = getTags(activeTrack, 'vibes', 'vibe');
    const activeFinish = activeTrack.finish || '';
    const activeCollections = Array.isArray(activeTrack.collections) ? activeTrack.collections.filter(Boolean) : [];
    const activeYear = activeTrack.year || 0;

    if (selectedInstruments.length > 0 && !activeInstruments.some(tag => selectedInstruments.includes(tag)) && activeInstruments[0]) {
      setSelectedInstruments(prev => prev.includes(activeInstruments[0]) ? prev : [...prev, activeInstruments[0]]);
    }
    if (activeInstruments.some(tag => excludedInstruments.includes(tag))) {
      setExcludedInstruments(prev => prev.filter(tag => !activeInstruments.includes(tag)));
    }
    if (selectedVibes.length > 0 && !activeVibes.some(tag => selectedVibes.includes(tag)) && activeVibes[0]) {
      setSelectedVibes(prev => prev.includes(activeVibes[0]) ? prev : [...prev, activeVibes[0]]);
    }
    if (activeVibes.some(tag => excludedVibes.includes(tag))) {
      setExcludedVibes(prev => prev.filter(tag => !activeVibes.includes(tag)));
    }
    if (selectedFinishes.length > 0 && activeFinish && !selectedFinishes.includes(activeFinish)) {
      setSelectedFinishes(prev => prev.includes(activeFinish) ? prev : [...prev, activeFinish]);
    }
    if (activeFinish && excludedFinishes.includes(activeFinish)) {
      setExcludedFinishes(prev => prev.filter(finish => finish !== activeFinish));
    }
    if (selectedCollections.length > 0 && !activeCollections.some(collection => selectedCollections.includes(collection)) && activeCollections[0]) {
      setSelectedCollections(prev => prev.includes(activeCollections[0]) ? prev : [...prev, activeCollections[0]]);
    }
    if (activeCollections.some(collection => excludedCollections.includes(collection))) {
      setExcludedCollections(prev => prev.filter(collection => !activeCollections.includes(collection)));
    }
    if (selectedYears.length > 0 && !selectedYears.includes(activeYear) && activeYear) {
      setSelectedYears(prev => prev.includes(activeYear) ? prev : [...prev, activeYear]);
    }
    if (activeYear && excludedYears.includes(activeYear)) {
      setExcludedYears(prev => prev.filter(year => year !== activeYear));
    }
    const activeAdamRating = getAdamRating(activeTrack);
    if (selectedAdamRatings.length > 0 && !selectedAdamRatings.includes(activeAdamRating)) {
      setSelectedAdamRatings(prev => prev.includes(activeAdamRating) ? prev : [...prev, activeAdamRating]);
    }
    if (excludedAdamRatings.includes(activeAdamRating)) {
      setExcludedAdamRatings(prev => prev.filter(rating => rating !== activeAdamRating));
    }

    window.setTimeout(() => {
      activeCardElementRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 0);
  }, [activeTrack, excludedAdamRatings, excludedCollections, excludedFinishes, excludedInstruments, excludedVibes, excludedYears, selectedAdamRatings, selectedCollections, selectedFinishes, selectedInstruments, selectedVibes, selectedYears]);

  const showActivityTrack = useCallback((file: AudioFile) => {
    const fileInstruments = getTags(file, 'instruments', 'instrument');
    const fileVibes = getTags(file, 'vibes', 'vibe');
    const fileFinish = file.finish || '';
    const fileCollections = Array.isArray(file.collections) ? file.collections.filter(Boolean) : [];
    const fileYear = file.year || 0;
    const fileAdamRating = getAdamRating(file);

    setRandomTrackIds(null);
    setLikedOnly(false);
    setUntaggedOnly(false);
    setSearchQuery('');
    setActivityTargetTrackId(file.id);
    setRenderWindow(prev => ({ ...prev, key: '', limit: INITIAL_RENDER_LIMIT }));

    if (selectedInstruments.length > 0 && !fileInstruments.some(tag => selectedInstruments.includes(tag)) && fileInstruments[0]) {
      setSelectedInstruments(prev => prev.includes(fileInstruments[0]) ? prev : [...prev, fileInstruments[0]]);
    }
    if (fileInstruments.some(tag => excludedInstruments.includes(tag))) {
      setExcludedInstruments(prev => prev.filter(tag => !fileInstruments.includes(tag)));
    }
    if (selectedVibes.length > 0 && !fileVibes.some(tag => selectedVibes.includes(tag)) && fileVibes[0]) {
      setSelectedVibes(prev => prev.includes(fileVibes[0]) ? prev : [...prev, fileVibes[0]]);
    }
    if (fileVibes.some(tag => excludedVibes.includes(tag))) {
      setExcludedVibes(prev => prev.filter(tag => !fileVibes.includes(tag)));
    }
    if (selectedFinishes.length > 0 && fileFinish && !selectedFinishes.includes(fileFinish)) {
      setSelectedFinishes(prev => prev.includes(fileFinish) ? prev : [...prev, fileFinish]);
    }
    if (fileFinish && excludedFinishes.includes(fileFinish)) {
      setExcludedFinishes(prev => prev.filter(finish => finish !== fileFinish));
    }
    if (selectedCollections.length > 0 && !fileCollections.some(collection => selectedCollections.includes(collection)) && fileCollections[0]) {
      setSelectedCollections(prev => prev.includes(fileCollections[0]) ? prev : [...prev, fileCollections[0]]);
    }
    if (fileCollections.some(collection => excludedCollections.includes(collection))) {
      setExcludedCollections(prev => prev.filter(collection => !fileCollections.includes(collection)));
    }
    if (selectedYears.length > 0 && fileYear && !selectedYears.includes(fileYear)) {
      setSelectedYears(prev => prev.includes(fileYear) ? prev : [...prev, fileYear]);
    }
    if (fileYear && excludedYears.includes(fileYear)) {
      setExcludedYears(prev => prev.filter(year => year !== fileYear));
    }
    if (selectedAdamRatings.length > 0 && !selectedAdamRatings.includes(fileAdamRating)) {
      setSelectedAdamRatings(prev => prev.includes(fileAdamRating) ? prev : [...prev, fileAdamRating]);
    }
    if (excludedAdamRatings.includes(fileAdamRating)) {
      setExcludedAdamRatings(prev => prev.filter(rating => rating !== fileAdamRating));
    }
  }, [excludedAdamRatings, excludedCollections, excludedFinishes, excludedInstruments, excludedVibes, excludedYears, selectedAdamRatings, selectedCollections, selectedFinishes, selectedInstruments, selectedVibes, selectedYears]);

  const toggleFilterCollapsed = (filter: keyof typeof collapsedFilters) => {
    setCollapsedFilters(prev => ({ ...prev, [filter]: !prev[filter] }));
  };

  const filterSummary = (selected: Array<string | number>, excluded: Array<string | number> = []) => {
    const includedText = selected.map(value => typeof value === 'string' ? displayTag(value) : value).join(', ');
    const excludedText = excluded.map(value => typeof value === 'string' ? displayTag(value) : value).join(', ');
    if (!includedText && !excludedText) return 'All';
    return [
      includedText,
      excludedText ? `Not ${excludedText}` : '',
    ].filter(Boolean).join(' · ');
  };

  const ratingFilterLabel = (rating: number) => rating > 0 ? `${rating} Star${rating === 1 ? '' : 's'}` : 'Unrated';

  const ratingFilterSummary = (selected: number[], excluded: number[]) => {
    const includedText = selected.map(ratingFilterLabel).join(', ');
    const excludedText = excluded.map(ratingFilterLabel).join(', ');
    if (!includedText && !excludedText) return 'All';
    return [
      includedText,
      excludedText ? `Not ${excludedText}` : '',
    ].filter(Boolean).join(' · ');
  };

  const getFilterMode = <T extends FilterValue>(value: T, selected: T[], excluded: T[]): FilterMode => {
    if (selected.includes(value)) return 'include';
    if (excluded.includes(value)) return 'exclude';
    return 'none';
  };

  const toggleFilterValue = <T extends FilterValue>(
    value: T,
    selected: T[],
    setSelected: Dispatch<SetStateAction<T[]>>,
    excluded: T[],
    setExcluded: Dispatch<SetStateAction<T[]>>
  ) => {
    if (selected.includes(value)) {
      setSelected(prev => prev.filter(selectedValue => selectedValue !== value));
      return;
    }
    if (excluded.includes(value)) {
      setExcluded(prev => prev.filter(excludedValue => excludedValue !== value));
      return;
    }
    setSelected(prev => [...prev, value]);
    setExcluded(prev => prev.filter(excludedValue => excludedValue !== value));
  };

  const excludeFilterValue = <T extends FilterValue>(
    value: T,
    setSelected: Dispatch<SetStateAction<T[]>>,
    setExcluded: Dispatch<SetStateAction<T[]>>
  ) => {
    setSelected(prev => prev.filter(selectedValue => selectedValue !== value));
    setExcluded(prev => prev.includes(value) ? prev : [...prev, value]);
  };

  const activeFilterCount =
    selectedInstruments.length + selectedVibes.length + selectedCollections.length + selectedFinishes.length + selectedYears.length + selectedAdamRatings.length +
    excludedInstruments.length + excludedVibes.length + excludedCollections.length + excludedFinishes.length + excludedYears.length + excludedAdamRatings.length +
    (likedOnly ? 1 : 0) + (untaggedOnly ? 1 : 0) + (searchQuery.trim() ? 1 : 0);
  const collapsedSummaryClass = "mb-2 w-full rounded border border-border/50 bg-[#20231f] px-3 py-2 text-left text-xs font-light text-muted-foreground opacity-85 transition hover:border-accent/35 hover:text-foreground";
  const filterOptionClass = (mode: FilterMode) => {
    const modeClass = {
      include: 'border border-accent/55 bg-accent/85 text-accent-foreground shadow-sm shadow-accent/10',
      exclude: 'border border-red-400/40 bg-red-500/10 text-red-300 hover:bg-red-500/15',
      none: 'border border-border/40 bg-[#20231f] text-muted-foreground hover:border-accent/35 hover:text-foreground',
    }[mode];
    return `flex cursor-pointer items-center justify-between gap-3 rounded p-3 text-sm transition-colors md:p-2 ${modeClass}`;
  };

  const filterCountClass = (mode: FilterMode) => {
    if (mode === 'include') return 'text-accent-foreground/75';
    if (mode === 'exclude') return 'text-red-200/75';
    return 'text-muted-foreground/70';
  };

  const cycleEndMode = () => {
    setEndMode(prev => {
      if (prev === 'stop') return 'next';
      if (prev === 'next') return 'repeat';
      return 'stop';
    });
  };

  const endModeLabel = {
    stop: 'Stop at end',
    next: 'Continue to next song',
    repeat: 'Repeat song',
  }[endMode];

  return (
    <div className="archive-shell min-h-screen text-foreground">
      <header className="container mx-auto grid gap-4 p-3 pb-1 sm:p-4 sm:pb-2 md:grid-cols-[16rem_minmax(0,1fr)]">
        <div className="hidden md:block" />
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <Image
            src="/adams_archive_waveform_logo_transparent.png"
            alt="Adam's Archive"
            width={2048}
            height={683}
            priority
            className="h-16 w-auto max-w-full object-contain sm:h-20"
          />
          <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
            {currentUser && (
              <span className="col-span-2 rounded border border-border/60 bg-muted/25 px-3 py-2 text-center text-sm text-muted-foreground sm:col-span-1">
                {currentUser.name}
              </span>
            )}
            {currentUser?.isAdmin && (
              <>
              <Link
                href="/manage"
                className="rounded border border-border/50 bg-muted/35 px-4 py-3 text-center text-sm text-muted-foreground transition hover:border-accent/40 hover:text-foreground sm:py-2"
              >
                Manage
              </Link>
              <Link
                href="/users"
                className="rounded border border-border/50 bg-muted/35 px-4 py-3 text-center text-sm text-muted-foreground transition hover:border-accent/40 hover:text-foreground sm:py-2"
              >
                Users
              </Link>
              <Link
                href="/upload"
                  className="rounded border border-accent/55 bg-accent/85 px-4 py-3 text-center text-sm text-accent-foreground shadow-sm shadow-accent/10 transition hover:bg-accent sm:py-2"
                >
                  Upload
                </Link>
              </>
            )}
            <button
              type="button"
              onClick={logout}
              className="rounded border border-border/50 bg-muted/35 px-4 py-3 text-sm text-muted-foreground transition hover:border-accent/40 hover:text-foreground sm:py-2"
            >
              Logout
            </button>
          </div>
        </div>
      </header>
      <div className="container mx-auto flex flex-col gap-4 p-3 pb-56 sm:p-4 sm:pb-36 md:flex-row">
        <div className="md:hidden">
          <button
            type="button"
            onClick={() => setShowMobileFilters(prev => !prev)}
            className="flex w-full items-center justify-between rounded border border-border bg-muted/40 px-4 py-3 text-left font-medium text-foreground"
            aria-expanded={showMobileFilters}
          >
            <span>Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}</span>
            <span className="text-muted-foreground">{showMobileFilters ? '-' : '+'}</span>
          </button>
        </div>
        <div className={`${showMobileFilters ? 'block' : 'hidden'} w-full rounded border border-border/60 bg-[#191b19]/95 p-3 pb-6 shadow-2xl shadow-black/20 md:sticky md:top-4 md:block md:max-h-[calc(100vh-2rem)] md:w-64 md:shrink-0 md:overflow-y-auto md:rounded-none md:border-0 md:border-r md:border-border/60 md:bg-transparent md:p-0 md:pr-4 md:pb-44 md:shadow-none`}>
          <h2 className="mb-4 hidden text-lg font-semibold md:block">Filters</h2>
          <div className="mb-6 rounded border border-border/50 bg-muted/30 p-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={likedOnly}
                onChange={(event) => setLikedOnly(event.target.checked)}
                className="h-4 w-4 accent-accent"
              />
              Liked songs
            </label>
            {currentUser?.id === 'adam' && (
              <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={untaggedOnly}
                  onChange={(event) => setUntaggedOnly(event.target.checked)}
                  className="h-4 w-4 accent-accent"
                />
                Untagged songs
              </label>
            )}
          </div>
          <div className="mb-6">
            <button
              type="button"
              onClick={() => toggleFilterCollapsed('instruments')}
              className="mb-2 flex w-full items-center justify-between pr-4 text-left text-md font-medium"
            >
              <span>Instruments</span>
              <span className="text-muted-foreground">{collapsedFilters.instruments ? '+' : '-'}</span>
            </button>
            {collapsedFilters.instruments && (
              <button type="button" onClick={() => toggleFilterCollapsed('instruments')} className={collapsedSummaryClass}>
                {filterSummary(selectedInstruments, excludedInstruments)}
              </button>
            )}
            {!collapsedFilters.instruments && <div className="space-y-1">
              {instrumentOptions.map(inst => {
                const mode = getFilterMode(inst, selectedInstruments, excludedInstruments);
                return (
                <div
                  key={inst}
                  onClick={() => toggleFilterValue(inst, selectedInstruments, setSelectedInstruments, excludedInstruments, setExcludedInstruments)}
                  className={filterOptionClass(mode)}
                >
                  <span>{displayTag(inst)}</span>
                  <span className="flex items-center gap-2">
                    {mode === 'include' && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          excludeFilterValue(inst, setSelectedInstruments, setExcludedInstruments);
                        }}
                        className="inline-flex h-5 w-5 items-center justify-center rounded border border-accent-foreground/40 text-xs text-accent-foreground/80 hover:bg-accent-foreground/10"
                        aria-label={`Exclude ${displayTag(inst)}`}
                      >
                        -
                      </button>
                    )}
                    {mode === 'exclude' && (
                      <span className="text-[10px] font-medium uppercase tracking-wide text-red-200/70">Excluded</span>
                    )}
                    <span className={filterCountClass(mode)}>{filterCounts.instruments.get(inst) || 0}</span>
                  </span>
                </div>
                );
              })}
            </div>}
          </div>
          <div className="mb-6">
            <button
              type="button"
              onClick={() => toggleFilterCollapsed('vibes')}
              className="mb-2 flex w-full items-center justify-between pr-4 text-left text-md font-medium"
            >
              <span>Vibe</span>
              <span className="text-muted-foreground">{collapsedFilters.vibes ? '+' : '-'}</span>
            </button>
            {collapsedFilters.vibes && (
              <button type="button" onClick={() => toggleFilterCollapsed('vibes')} className={collapsedSummaryClass}>
                {filterSummary(selectedVibes, excludedVibes)}
              </button>
            )}
            {!collapsedFilters.vibes && <div className="space-y-1">
              {vibeOptions.map(v => {
                const mode = getFilterMode(v, selectedVibes, excludedVibes);
                return (
                <div
                  key={v}
                  onClick={() => toggleFilterValue(v, selectedVibes, setSelectedVibes, excludedVibes, setExcludedVibes)}
                  className={filterOptionClass(mode)}
                >
                  <span>{displayTag(v)}</span>
                  <span className="flex items-center gap-2">
                    {mode === 'include' && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          excludeFilterValue(v, setSelectedVibes, setExcludedVibes);
                        }}
                        className="inline-flex h-5 w-5 items-center justify-center rounded border border-accent-foreground/40 text-xs text-accent-foreground/80 hover:bg-accent-foreground/10"
                        aria-label={`Exclude ${displayTag(v)}`}
                      >
                        -
                      </button>
                    )}
                    {mode === 'exclude' && (
                      <span className="text-[10px] font-medium uppercase tracking-wide text-red-200/70">Excluded</span>
                    )}
                    <span className={filterCountClass(mode)}>{filterCounts.vibes.get(v) || 0}</span>
                  </span>
                </div>
                );
              })}
            </div>}
          </div>
          <div className="mb-6">
            <button
              type="button"
              onClick={() => toggleFilterCollapsed('collections')}
              className="mb-2 flex w-full items-center justify-between pr-4 text-left text-md font-medium"
            >
              <span>Collections</span>
              <span className="text-muted-foreground">{collapsedFilters.collections ? '+' : '-'}</span>
            </button>
            {collapsedFilters.collections && (
              <button type="button" onClick={() => toggleFilterCollapsed('collections')} className={collapsedSummaryClass}>
                {filterSummary(selectedCollections, excludedCollections)}
              </button>
            )}
            {!collapsedFilters.collections && <div className="space-y-1">
              {collectionOptions.length > 0 ? collectionOptions.map(collection => {
                const mode = getFilterMode(collection, selectedCollections, excludedCollections);
                return (
                <div
                  key={collection}
                  onClick={() => toggleFilterValue(collection, selectedCollections, setSelectedCollections, excludedCollections, setExcludedCollections)}
                  className={filterOptionClass(mode)}
                >
                  <span>{displayTag(collection)}</span>
                  <span className="flex items-center gap-2">
                    {mode === 'include' && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          excludeFilterValue(collection, setSelectedCollections, setExcludedCollections);
                        }}
                        className="inline-flex h-5 w-5 items-center justify-center rounded border border-accent-foreground/40 text-xs text-accent-foreground/80 hover:bg-accent-foreground/10"
                        aria-label={`Exclude ${displayTag(collection)}`}
                      >
                        -
                      </button>
                    )}
                    {mode === 'exclude' && (
                      <span className="text-[10px] font-medium uppercase tracking-wide text-red-200/70">Excluded</span>
                    )}
                    <span className={filterCountClass(mode)}>{filterCounts.collections.get(collection) || 0}</span>
                  </span>
                </div>
                );
              }) : (
                <p className="rounded border border-border/50 bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground">No collections yet</p>
              )}
            </div>}
          </div>
          <div className="mb-6">
            <button
              type="button"
              onClick={() => toggleFilterCollapsed('finish')}
              className="mb-2 flex w-full items-center justify-between pr-4 text-left text-md font-medium"
            >
              <span>Finish</span>
              <span className="text-muted-foreground">{collapsedFilters.finish ? '+' : '-'}</span>
            </button>
            {collapsedFilters.finish && (
              <button type="button" onClick={() => toggleFilterCollapsed('finish')} className={collapsedSummaryClass}>
                {filterSummary(selectedFinishes, excludedFinishes)}
              </button>
            )}
            {!collapsedFilters.finish && <div className="space-y-1">
              {finishOptions.map(finish => {
                const mode = getFilterMode(finish, selectedFinishes, excludedFinishes);
                return (
                <div
                  key={finish}
                  onClick={() => toggleFilterValue(finish, selectedFinishes, setSelectedFinishes, excludedFinishes, setExcludedFinishes)}
                  className={filterOptionClass(mode)}
                >
                  <span>{displayTag(finish)}</span>
                  <span className="flex items-center gap-2">
                    {mode === 'include' && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          excludeFilterValue(finish, setSelectedFinishes, setExcludedFinishes);
                        }}
                        className="inline-flex h-5 w-5 items-center justify-center rounded border border-accent-foreground/40 text-xs text-accent-foreground/80 hover:bg-accent-foreground/10"
                        aria-label={`Exclude ${displayTag(finish)}`}
                      >
                        -
                      </button>
                    )}
                    {mode === 'exclude' && (
                      <span className="text-[10px] font-medium uppercase tracking-wide text-red-200/70">Excluded</span>
                    )}
                    <span className={filterCountClass(mode)}>{filterCounts.finish.get(finish) || 0}</span>
                  </span>
                </div>
                );
              })}
            </div>}
          </div>
          <div className="mb-6">
            <button
              type="button"
              onClick={() => toggleFilterCollapsed('years')}
              className="mb-2 flex w-full items-center justify-between pr-4 text-left text-md font-medium"
            >
              <span>Year</span>
              <span className="text-muted-foreground">{collapsedFilters.years ? '+' : '-'}</span>
            </button>
            {collapsedFilters.years && (
              <button type="button" onClick={() => toggleFilterCollapsed('years')} className={collapsedSummaryClass}>
                {filterSummary(selectedYears, excludedYears)}
              </button>
            )}
            {!collapsedFilters.years && <div className="space-y-1">
              {yearOptions.map(year => {
                const mode = getFilterMode(year, selectedYears, excludedYears);
                return (
                <div
                  key={year}
                  onClick={() => toggleFilterValue(year, selectedYears, setSelectedYears, excludedYears, setExcludedYears)}
                  className={filterOptionClass(mode)}
                >
                  <span>{year}</span>
                  <span className="flex items-center gap-2">
                    {mode === 'include' && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          excludeFilterValue(year, setSelectedYears, setExcludedYears);
                        }}
                        className="inline-flex h-5 w-5 items-center justify-center rounded border border-accent-foreground/40 text-xs text-accent-foreground/80 hover:bg-accent-foreground/10"
                        aria-label={`Exclude ${year}`}
                      >
                        -
                      </button>
                    )}
                    {mode === 'exclude' && (
                      <span className="text-[10px] font-medium uppercase tracking-wide text-red-200/70">Excluded</span>
                    )}
                    <span className={filterCountClass(mode)}>{filterCounts.years.get(year) || 0}</span>
                  </span>
                </div>
                );
              })}
            </div>}
          </div>
          <div className="mb-6">
            <button
              type="button"
              onClick={() => toggleFilterCollapsed('adamsRatings')}
              className="mb-2 flex w-full items-center justify-between pr-4 text-left text-md font-medium"
            >
              <span>Adam&apos;s Rating</span>
              <span className="text-muted-foreground">{collapsedFilters.adamsRatings ? '+' : '-'}</span>
            </button>
            {collapsedFilters.adamsRatings && (
              <button type="button" onClick={() => toggleFilterCollapsed('adamsRatings')} className={collapsedSummaryClass}>
                {ratingFilterSummary(selectedAdamRatings, excludedAdamRatings)}
              </button>
            )}
            {!collapsedFilters.adamsRatings && <div className="space-y-1">
              {adamRatingOptions.map(rating => {
                const mode = getFilterMode(rating, selectedAdamRatings, excludedAdamRatings);
                return (
                <div
                  key={rating}
                  onClick={() => toggleFilterValue(rating, selectedAdamRatings, setSelectedAdamRatings, excludedAdamRatings, setExcludedAdamRatings)}
                  className={filterOptionClass(mode)}
                >
                  <span className={rating > 0 ? getRatingColor(rating) : undefined}>
                    {ratingFilterLabel(rating)}
                  </span>
                  <span className="flex items-center gap-2">
                    {mode === 'include' && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          excludeFilterValue(rating, setSelectedAdamRatings, setExcludedAdamRatings);
                        }}
                        className="inline-flex h-5 w-5 items-center justify-center rounded border border-accent-foreground/40 text-xs text-accent-foreground/80 hover:bg-accent-foreground/10"
                        aria-label={`Exclude ${ratingFilterLabel(rating)}`}
                      >
                        -
                      </button>
                    )}
                    {mode === 'exclude' && (
                      <span className="text-[10px] font-medium uppercase tracking-wide text-red-200/70">Excluded</span>
                    )}
                    <span className={filterCountClass(mode)}>{filterCounts.adamsRatings.get(rating) || 0}</span>
                  </span>
                </div>
                );
              })}
            </div>}
          </div>
          <div className="mb-6 rounded border border-border/50 bg-muted/30 p-3">
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search filenames"
              className="mb-3 w-full rounded border border-border bg-background p-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-accent md:p-2"
            />
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={searchNotes}
                onChange={(event) => setSearchNotes(event.target.checked)}
                className="h-3.5 w-3.5 accent-accent"
              />
              Include Notes
            </label>
          </div>
          <div className="space-y-2">
            <div className="flex">
              <input
                type="text"
                value={newInstrument}
                onChange={(e) => setNewInstrument(e.target.value)}
                placeholder="Add instrument"
                className="min-w-0 flex-1 rounded-l border border-border bg-background p-3 text-sm text-foreground md:p-2"
                onKeyDown={(e) => e.key === 'Enter' && addInstrument()}
              />
              <button
                onClick={addInstrument}
                className="rounded-r bg-accent px-4 py-3 text-accent-foreground hover:bg-accent/80 md:py-2"
              >
                +
              </button>
            </div>
            <div className="flex">
              <input
                type="text"
                value={newVibe}
                onChange={(e) => setNewVibe(e.target.value)}
                placeholder="Add vibe"
                className="min-w-0 flex-1 rounded-l border border-border bg-background p-3 text-sm text-foreground md:p-2"
                onKeyDown={(e) => e.key === 'Enter' && addVibe()}
              />
              <button
                onClick={addVibe}
                className="rounded-r bg-accent px-4 py-3 text-accent-foreground hover:bg-accent/80 md:py-2"
              >
                +
              </button>
            </div>
          </div>
        </div>
        <div className="flex-1 md:pl-4">
          {currentUser?.isAdmin && (
            <div className="mb-4 rounded border border-border/60 bg-muted/25 p-3">
              <button
                type="button"
                onClick={() => setShowActivity(prev => !prev)}
                className="flex w-full items-center justify-between gap-3 text-left"
                aria-expanded={showActivity}
              >
                <h2 className="text-sm font-medium text-foreground">Activity</h2>
                <span className="flex items-center gap-3 text-xs text-muted-foreground">
                  {activityEntries.length} item{activityEntries.length === 1 ? '' : 's'}
                  <span>{showActivity ? '-' : '+'}</span>
                </span>
              </button>
              {showActivity && activityEntries.length > 0 && (
                <div className="mt-3 max-h-[18rem] divide-y divide-border/50 overflow-y-auto border-y border-border/50">
                  {activityEntries.map(activity => (
                    <button
                      key={activity.id}
                      type="button"
                      onClick={() => showActivityTrack(activity.file)}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-background/60"
                    >
                      <span
                        className={`w-16 shrink-0 text-[10px] uppercase tracking-wide ${
                          activity.type === 'comment' ? 'text-accent' : 'text-muted-foreground'
                        }`}
                        title={formatActivityTitle(activity)}
                      >
                        {activity.type}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-foreground">{activity.file.name}</p>
                        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground/80">{activity.userName}</span>
                          <span>{activity.text}</span>
                          {activity.type === 'rating' && activity.rating !== undefined && (
                            <span className={`inline-flex items-center ${getRatingColor(activity.rating)}`}>
                              {[1, 2, 3, 4, 5].map(star => (
                                <StarIcon key={star} filled={star <= (activity.rating || 0)} size="h-3 w-3" />
                              ))}
                            </span>
                          )}
                        </div>
                      </div>
                      <span className="shrink-0 text-[10px] text-muted-foreground/75">
                        {formatActivityTime(activity.createdAt)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {showActivity && activityEntries.length === 0 && (
                <p className="mt-3 text-sm text-muted-foreground">No ratings or comments from other users yet.</p>
              )}
            </div>
          )}
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/50 bg-[#1b1d1b]/80 p-2 shadow-sm shadow-black/10">
            <div className="flex flex-wrap items-center gap-2 rounded border border-border/45 bg-[#151716] p-1.5">
              <button
                type="button"
                onClick={pickRandomTracks}
                disabled={randomCandidates.length === 0}
                className={`min-h-9 rounded px-3 py-1.5 text-sm transition disabled:opacity-50 ${
                  randomTrackIds
                    ? 'bg-accent text-accent-foreground hover:bg-accent/90'
                    : 'bg-[#20231f] text-muted-foreground hover:text-foreground'
                }`}
              >
                Random
              </button>
              <label className="flex cursor-pointer items-center gap-2 px-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={randomIncludeVoiceMemos}
                  onChange={(event) => setRandomIncludeVoiceMemos(event.target.checked)}
                  className="h-3.5 w-3.5 accent-accent"
                />
                Voice memos
              </label>
              {randomTrackIds && (
                <button
                  type="button"
                  onClick={() => setRandomTrackIds(null)}
                  className="min-h-9 rounded px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-[#20231f] hover:text-foreground"
                >
                  All
                </button>
              )}
            </div>
            <div className="flex flex-1 flex-wrap items-center justify-end gap-3 sm:flex-none">
              <label className="text-foreground">Sort by:</label>
              <select
                value={sortBy === 'adamsRatingRandom' ? 'adamsRating' : sortBy}
                onChange={(e) => setSortBy(e.target.value as SortBy)}
                className="min-h-11 flex-1 rounded border border-border/60 bg-[#151716] p-2 text-foreground outline-none transition focus:border-accent/60 sm:flex-none"
              >
                <option value="random">Random</option>
                <option value="name">Name</option>
                <option value="date">Date</option>
                <option value="uploadDate">Upload Date</option>
                <option value="adamsRating">Adam&apos;s Rating</option>
                <option value="userRating">User Rating</option>
              </select>
              <button
                onClick={() => {
                  if (sortBy === 'adamsRatingRandom') {
                    setSortBy('adamsRating');
                  }
                  setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
                }}
                className="min-h-11 rounded border border-accent/50 bg-accent/85 px-4 py-2 text-accent-foreground transition hover:bg-accent"
              >
                {sortDirection === 'asc' ? '↑' : '↓'}
              </button>
            </div>
          </div>
          <div className="space-y-4">
            {displayedFiles.map(file => {
              const hiddenActiveTrack = activeTrack?.id === file.id && !visibleFileIds.has(file.id);
              if (!currentUser) return null;

              return (
                <div
                  key={file.id}
                  className={hiddenActiveTrack ? 'hidden' : undefined}
                  ref={(element) => {
                    if (!element || file.id !== targetTrackId) return;
                    window.setTimeout(() => {
                      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      if (activityTargetTrackId === file.id) {
                        setActivityTargetTrackId(null);
                      }
                    }, 100);
                  }}
                >
                  <AudioCard
                    file={file}
                    setFiles={setFiles}
                    isActive={activeTrack?.id === file.id}
                    currentUser={currentUser}
                    accountUsers={accountUsers}
                    instrumentOptions={instrumentOptions}
                    vibeOptions={vibeOptions}
                    collectionOptions={collectionOptions}
                    onReady={handleCardReady}
                    onPlay={handleCardPlay}
                    onPause={handleCardPause}
                    onStop={handleCardStop}
                    onDestroy={clearActivePlayer}
                  />
                </div>
              );
            })}
            {hasMoreFiles && (
              <div ref={loadMoreRef} className="flex justify-center py-4">
                <button
                  type="button"
                  onClick={() => setRenderWindow(prev => {
                    const currentLimit = prev.key === filterKey ? prev.limit : INITIAL_RENDER_LIMIT;
                    return {
                      key: filterKey,
                      limit: Math.min(currentLimit + RENDER_BATCH_SIZE, renderedFiles.length),
                    };
                  })}
                  className="rounded border border-border px-4 py-2 text-sm text-muted-foreground transition hover:text-foreground"
                >
                  Load more
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      {activeTrack && (
        <div className="fixed bottom-3 left-3 right-3 z-50 rounded-md border border-border/70 bg-[#1b1d1b]/95 p-2 shadow-2xl shadow-black/45 backdrop-blur sm:bottom-4 sm:left-4 sm:right-4 sm:p-3 md:right-auto md:w-[min(360px,calc(100vw-2rem))]">
          <div className="flex flex-col gap-2 sm:gap-3 md:flex-row md:items-center">
            <div className="min-w-0 flex-1">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <h3 className="text-[10px] font-semibold uppercase leading-tight tracking-wide text-muted-foreground sm:text-xs">Now Playing</h3>
                  <button
                    type="button"
                    onClick={scrollToActiveCard}
                    className="block max-w-full truncate text-left text-sm font-semibold leading-tight text-foreground hover:text-accent sm:text-base"
                  >
                    {activeTrack.name}
                  </button>
                </div>
                <div className="flex shrink-0 items-center gap-1 sm:hidden">
                  <button
                    onClick={toggleMiniPlayer}
                    className="flex h-9 w-10 items-center justify-center rounded bg-accent text-accent-foreground transition hover:bg-accent/90"
                    aria-label={isPlaying ? `Pause ${activeTrack.name}` : `Play ${activeTrack.name}`}
                  >
                    {isPlaying ? (
                      <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                        <path d="M5 4h3v12H5V4zm7 0h3v12h-3V4z"/>
                      </svg>
                    ) : (
                      <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                        <path d="M8 5v10l8-5-8-5z"/>
                      </svg>
                    )}
                  </button>
                  <button
                    onClick={cycleEndMode}
                    className={`flex h-9 w-10 items-center justify-center rounded transition ${
                      endMode !== 'stop' ? 'bg-accent text-accent-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80'
                    }`}
                    aria-label={`${endModeLabel} for ${activeTrack.name}`}
                    title={endModeLabel}
                  >
                    {endMode === 'next' ? (
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14m-4-4 4 4-4 4" />
                      </svg>
                    ) : (
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 1l4 4-4 4M3 11V9a4 4 0 014-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 01-4 4H3" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
              <p className="truncate text-sm text-muted-foreground">
                {[...getTags(activeTrack, 'instruments', 'instrument'), ...getTags(activeTrack, 'vibes', 'vibe'), activeTrack.finish || ''].filter(Boolean).map(displayTag).join(' · ') || 'No tags'}
              </p>
              <div
                className="mt-2 h-3 w-full cursor-pointer overflow-hidden rounded-full border border-border/30 bg-[#101211]"
                onPointerDown={seekMiniPlayer}
                role="slider"
                aria-label={`Seek ${activeTrack.name}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress)}
              >
                <div className="h-full bg-accent transition-all duration-200" style={{ width: `${progress}%` }} />
              </div>
            </div>
            <div className="hidden items-center gap-2 sm:flex">
              <button
                onClick={toggleMiniPlayer}
              className="flex h-10 w-12 items-center justify-center rounded border border-accent/50 bg-accent/85 text-accent-foreground transition hover:bg-accent"
                aria-label={isPlaying ? `Pause ${activeTrack.name}` : `Play ${activeTrack.name}`}
              >
                {isPlaying ? (
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                    <path d="M5 4h3v12H5V4zm7 0h3v12h-3V4z"/>
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                    <path d="M8 5v10l8-5-8-5z"/>
                  </svg>
                )}
              </button>
              <button
                onClick={cycleEndMode}
                className={`flex h-10 w-12 items-center justify-center rounded transition ${
                  endMode !== 'stop' ? 'bg-accent text-accent-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
                aria-label={`${endModeLabel} for ${activeTrack.name}`}
                title={endModeLabel}
              >
                {endMode === 'next' ? (
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14m-4-4 4 4-4 4" />
                  </svg>
                ) : (
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 1l4 4-4 4M3 11V9a4 4 0 014-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 01-4 4H3" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
