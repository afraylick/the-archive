'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

type EndMode = 'repeat' | 'next' | 'stop';

interface PlayerRegistryEntry {
  cardElement: HTMLDivElement;
  wavesurfer: WaveSurfer;
}

const DEFAULT_INSTRUMENTS = ['E. Guitar', 'Keys', 'Vocal', 'Synth', 'Acoustic', 'Bass', 'Drums', 'Drum Machine', 'Uku'];
const DEFAULT_VIBES = ['ambient', 'rock', 'indie', 'acoustic', 'hard', 'soft', 'country', 'electronic', 'Chill', 'Gainy', 'Spacey', 'Beats', 'Group Jam'];
const FINISH_OPTIONS = ['Tracked', 'Recorder', 'Voice Memo'];
const INITIAL_RENDER_LIMIT = 30;
const RENDER_BATCH_SIZE = 30;
const WAVEFORM_PEAK_LENGTH = 1200;
const WAVEFORM_PEAK_PRECISION = 1000;
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

const hasCachedWaveform = (file: AudioFile) => (
  Array.isArray(file.waveformPeaks) &&
  file.waveformPeaks.length > 0 &&
  Array.isArray(file.waveformPeaks[0]) &&
  file.waveformPeaks[0].length > 0 &&
  typeof file.waveformDuration === 'number' &&
  file.waveformDuration > 0
);

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
        precision: 3,
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

    const ratingData = await res.json() as Pick<AudioFile, 'ratings' | 'myRating' | 'userRating'>;
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
    setOpenTagPicker(null);
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
    <div ref={cardRef} className="relative rounded-lg border border-border bg-[#141414] p-3 shadow-md scroll-mt-24 sm:p-4">
      <div className="grid gap-4 md:grid-cols-[minmax(220px,0.9fr)_minmax(360px,1.4fr)] md:items-center">
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
                      <h2 className="break-words text-lg font-semibold text-foreground sm:text-xl">{file.name}</h2>
                      {file.originalName && file.originalName !== file.name && (
                        <p className="mt-0.5 break-words text-[11px] font-light text-muted-foreground opacity-70">
                          {file.originalName}
                        </p>
                      )}
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
                    className="rounded border border-border bg-muted px-2 py-1.5 text-xs text-muted-foreground"
                  >
                    {displayTag(tag)}
                  </button>
                ))}
                {currentUser.isAdmin && (
                  <button
                    type="button"
                    onClick={() => setOpenTagPicker(prev => prev === 'instruments' ? null : 'instruments')}
                    className="inline-flex h-9 w-9 items-center justify-center rounded border border-border bg-muted text-sm text-muted-foreground hover:bg-muted/80 sm:h-6 sm:w-6"
                    aria-label={`Add instrument tag to ${file.name}`}
                  >
                    {openTagPicker === 'instruments' ? '-' : '+'}
                  </button>
                )}
              </div>
              {currentUser.isAdmin && openTagPicker === 'instruments' && (
                <div className="mt-2 flex flex-wrap gap-2 rounded border border-border bg-muted p-2">
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
                    className="rounded border border-border bg-muted px-2 py-1.5 text-xs text-muted-foreground"
                  >
                    {displayTag(tag)}
                  </button>
                ))}
                {currentUser.isAdmin && (
                  <button
                    type="button"
                    onClick={() => setOpenTagPicker(prev => prev === 'vibes' ? null : 'vibes')}
                    className="inline-flex h-9 w-9 items-center justify-center rounded border border-border bg-muted text-sm text-muted-foreground hover:bg-muted/80 sm:h-6 sm:w-6"
                    aria-label={`Add vibe tag to ${file.name}`}
                  >
                    {openTagPicker === 'vibes' ? '-' : '+'}
                  </button>
                )}
              </div>
              {currentUser.isAdmin && openTagPicker === 'vibes' && (
                <div className="mt-2 flex flex-wrap gap-2 rounded border border-border bg-muted p-2">
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
          <div className="grid grid-cols-[7.5rem_auto] items-center gap-x-2 gap-y-1 sm:grid-cols-[7.5rem_auto]">
            <span className="text-sm text-foreground">Adam&apos;s Rating</span>
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
            <span className="text-sm text-foreground">Your Rating</span>
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
                  <span className="text-sm text-foreground">{user.name}</span>
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
        <div className="order-1 relative flex min-h-56 min-w-0 items-center justify-center sm:min-h-48 md:order-2">
          <div className="absolute right-0 top-0 z-10 flex items-start gap-1">
            <button
              type="button"
              onClick={refreshWaveform}
              disabled={waveformRefreshing}
              className="inline-flex h-8 w-8 items-center justify-center rounded border border-border/60 bg-background/80 text-muted-foreground opacity-55 transition hover:border-border hover:text-foreground hover:opacity-85 disabled:opacity-35"
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
                    : 'border-border/60 bg-background/80 text-muted-foreground hover:border-border hover:text-foreground'
              }`}
              title={`Boost this song by ${VOL_BOOST_DB} dB`}
            >
              {isVolumeBoosted ? `+${VOL_BOOST_DB} dB` : volumeBoostConfirming ? 'Confirm' : 'Vol Boost'}
            </button>
          </div>
          <div 
            ref={waveformRef} 
            className="mx-auto mb-2 min-h-56 w-full max-w-[760px] cursor-pointer sm:min-h-44" 
            onClick={(e) => {
              if (wavesurferRef.current) {
                const rect = waveformRef.current!.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const progress = x / rect.width;
                wavesurferRef.current.seekTo(progress);
                setCurrentTime((duration || file.waveformDuration || 0) * progress);
                wavesurferRef.current.play();
              }
            }}
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
  const [likedOnly, setLikedOnly] = useState(false);
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchNotes, setSearchNotes] = useState(false);
  const [collapsedFilters, setCollapsedFilters] = useState({
    instruments: true,
    vibes: true,
    finish: true,
    collections: true,
    years: true,
  });
  const [instrumentOptions, setInstrumentOptions] = useState<string[]>(DEFAULT_INSTRUMENTS);
  const [vibeOptions, setVibeOptions] = useState<string[]>(DEFAULT_VIBES);
  const [newInstrument, setNewInstrument] = useState('');
  const [newVibe, setNewVibe] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'date' | 'adamsRating' | 'userRating'>('adamsRating');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [randomTrackIds, setRandomTrackIds] = useState<string[] | null>(null);
  const [randomIncludeVoiceMemos, setRandomIncludeVoiceMemos] = useState(false);
  const [activeTrack, setActiveTrack] = useState<AudioFile | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [endMode, setEndMode] = useState<EndMode>('stop');
  const [renderWindow, setRenderWindow] = useState({ key: '', limit: INITIAL_RENDER_LIMIT });
  const targetTrackId = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('track');
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
      case 'adamsRating':
        aVal = a.myRating;
        bVal = b.myRating;
        break;
      case 'userRating':
        aVal = a.userRating;
        bVal = b.userRating;
        break;
      default:
        return 0;
    }
    if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
    if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
    return 0;
  }, [sortBy, sortDirection]);

  const matchesFilters = useCallback((file: AudioFile) => {
    const normalizedSearch = searchQuery.trim().toLowerCase();
    const fileCollections = Array.isArray(file.collections) ? file.collections.filter(Boolean) : [];
    const matchesSearch = normalizedSearch.length === 0
      || file.name.toLowerCase().includes(normalizedSearch)
      || (searchNotes && getNoteText(file).toLowerCase().includes(normalizedSearch));

    return (
      matchesSearch &&
      (!likedOnly || Boolean(file.liked)) &&
      (selectedInstruments.length === 0 || getTags(file, 'instruments', 'instrument').some(tag => selectedInstruments.includes(tag))) &&
      (selectedVibes.length === 0 || getTags(file, 'vibes', 'vibe').some(tag => selectedVibes.includes(tag))) &&
      (selectedFinishes.length === 0 || (file.finish ? selectedFinishes.includes(file.finish) : false)) &&
      (selectedCollections.length === 0 || fileCollections.some(collection => selectedCollections.includes(collection))) &&
      (selectedYears.length === 0 || selectedYears.includes(file.year || 0))
    );
  }, [likedOnly, searchNotes, searchQuery, selectedCollections, selectedFinishes, selectedInstruments, selectedVibes, selectedYears]);

  const matchesRandomFilters = useCallback((file: AudioFile) => {
    const normalizedSearch = searchQuery.trim().toLowerCase();
    const fileCollections = Array.isArray(file.collections) ? file.collections.filter(Boolean) : [];
    const matchesSearch = normalizedSearch.length === 0
      || file.name.toLowerCase().includes(normalizedSearch)
      || (searchNotes && getNoteText(file).toLowerCase().includes(normalizedSearch));
    const finish = file.finish || '';

    return (
      matchesSearch &&
      (!likedOnly || Boolean(file.liked)) &&
      (randomIncludeVoiceMemos || finish !== 'Voice Memo') &&
      (selectedInstruments.length === 0 || getTags(file, 'instruments', 'instrument').some(tag => selectedInstruments.includes(tag))) &&
      (selectedVibes.length === 0 || getTags(file, 'vibes', 'vibe').some(tag => selectedVibes.includes(tag))) &&
      (selectedCollections.length === 0 || fileCollections.some(collection => selectedCollections.includes(collection))) &&
      (selectedYears.length === 0 || selectedYears.includes(file.year || 0))
    );
  }, [likedOnly, randomIncludeVoiceMemos, searchNotes, searchQuery, selectedCollections, selectedInstruments, selectedVibes, selectedYears]);

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
    likedOnly,
    randomTrackIds,
    sortBy,
    sortDirection,
  }), [likedOnly, randomTrackIds, searchNotes, searchQuery, selectedCollections, selectedFinishes, selectedInstruments, selectedVibes, selectedYears, sortBy, sortDirection]);

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
  const finishOptions = Array.from(new Set([...FINISH_OPTIONS, ...files.map(file => file.finish || '').filter(Boolean)]));
  const collectionOptions = Array.from(new Set(files.flatMap(file => Array.isArray(file.collections) ? file.collections.filter(Boolean) : []))).sort((a, b) => a.localeCompare(b));

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
    const shuffled = [...randomCandidates];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

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
    if (selectedVibes.length > 0 && !activeVibes.some(tag => selectedVibes.includes(tag)) && activeVibes[0]) {
      setSelectedVibes(prev => prev.includes(activeVibes[0]) ? prev : [...prev, activeVibes[0]]);
    }
    if (selectedFinishes.length > 0 && activeFinish && !selectedFinishes.includes(activeFinish)) {
      setSelectedFinishes(prev => prev.includes(activeFinish) ? prev : [...prev, activeFinish]);
    }
    if (selectedCollections.length > 0 && !activeCollections.some(collection => selectedCollections.includes(collection)) && activeCollections[0]) {
      setSelectedCollections(prev => prev.includes(activeCollections[0]) ? prev : [...prev, activeCollections[0]]);
    }
    if (selectedYears.length > 0 && !selectedYears.includes(activeYear) && activeYear) {
      setSelectedYears(prev => prev.includes(activeYear) ? prev : [...prev, activeYear]);
    }

    window.setTimeout(() => {
      activeCardElementRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 0);
  }, [activeTrack, selectedCollections, selectedFinishes, selectedInstruments, selectedVibes, selectedYears]);

  const toggleFilterCollapsed = (filter: keyof typeof collapsedFilters) => {
    setCollapsedFilters(prev => ({ ...prev, [filter]: !prev[filter] }));
  };

  const filterSummary = (selected: Array<string | number>) => {
    if (selected.length === 0) return 'All';
    return selected.map(value => typeof value === 'string' ? displayTag(value) : value).join(', ');
  };

  const activeFilterCount = selectedInstruments.length + selectedVibes.length + selectedCollections.length + selectedFinishes.length + selectedYears.length + (likedOnly ? 1 : 0) + (searchQuery.trim() ? 1 : 0);
  const collapsedSummaryClass = "mb-2 w-full rounded border border-border/50 bg-muted/40 px-3 py-2 text-left text-xs font-light text-muted-foreground opacity-80 transition hover:border-border hover:text-foreground";
  const filterOptionClass = (selected: boolean) => `cursor-pointer rounded p-3 text-sm transition-colors md:p-2 ${
    selected ? 'bg-accent text-accent-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80'
  }`;

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
    <div className="bg-background text-foreground min-h-screen">
      <header className="container mx-auto grid gap-4 p-3 sm:p-4 md:grid-cols-[16rem_minmax(0,1fr)]">
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
              <span className="col-span-2 rounded border border-border px-3 py-2 text-center text-sm text-muted-foreground sm:col-span-1">
                {currentUser.name}
              </span>
            )}
            {currentUser?.isAdmin && (
              <>
              <Link
                href="/manage"
                className="rounded bg-muted px-4 py-3 text-center text-sm text-muted-foreground transition hover:bg-muted/80 sm:py-2"
              >
                Manage
              </Link>
              <Link
                href="/users"
                className="rounded bg-muted px-4 py-3 text-center text-sm text-muted-foreground transition hover:bg-muted/80 sm:py-2"
              >
                Users
              </Link>
              <Link
                href="/upload"
                  className="rounded bg-accent px-4 py-3 text-center text-sm text-accent-foreground transition hover:bg-accent/80 sm:py-2"
                >
                  Upload
                </Link>
              </>
            )}
            <button
              type="button"
              onClick={logout}
              className="rounded bg-muted px-4 py-3 text-sm text-muted-foreground transition hover:bg-muted/80 sm:py-2"
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
        <div className={`${showMobileFilters ? 'block' : 'hidden'} w-full rounded border border-border/60 bg-background/95 p-3 pb-6 md:sticky md:top-4 md:block md:max-h-[calc(100vh-2rem)] md:w-64 md:shrink-0 md:overflow-y-auto md:rounded-none md:border-0 md:border-r md:bg-transparent md:p-0 md:pr-4 md:pb-44`}>
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
                {filterSummary(selectedInstruments)}
              </button>
            )}
            {!collapsedFilters.instruments && <div className="space-y-1">
              {instrumentOptions.map(inst => (
                <div
                  key={inst}
                  onClick={() => {
                    if (selectedInstruments.includes(inst)) {
                      setSelectedInstruments(selectedInstruments.filter(i => i !== inst));
                    } else {
                      setSelectedInstruments([...selectedInstruments, inst]);
                    }
                  }}
                  className={filterOptionClass(selectedInstruments.includes(inst))}
                >
                  {displayTag(inst)}
                </div>
              ))}
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
                {filterSummary(selectedVibes)}
              </button>
            )}
            {!collapsedFilters.vibes && <div className="space-y-1">
              {vibeOptions.map(v => (
                <div
                  key={v}
                  onClick={() => {
                    if (selectedVibes.includes(v)) {
                      setSelectedVibes(selectedVibes.filter(vb => vb !== v));
                    } else {
                      setSelectedVibes([...selectedVibes, v]);
                    }
                  }}
                  className={filterOptionClass(selectedVibes.includes(v))}
                >
                  {displayTag(v)}
                </div>
              ))}
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
                {filterSummary(selectedCollections)}
              </button>
            )}
            {!collapsedFilters.collections && <div className="space-y-1">
              {collectionOptions.length > 0 ? collectionOptions.map(collection => (
                <div
                  key={collection}
                  onClick={() => {
                    if (selectedCollections.includes(collection)) {
                      setSelectedCollections(selectedCollections.filter(selectedCollection => selectedCollection !== collection));
                    } else {
                      setSelectedCollections([...selectedCollections, collection]);
                    }
                  }}
                  className={filterOptionClass(selectedCollections.includes(collection))}
                >
                  {displayTag(collection)}
                </div>
              )) : (
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
                {filterSummary(selectedFinishes)}
              </button>
            )}
            {!collapsedFilters.finish && <div className="space-y-1">
              {finishOptions.map(finish => (
                <div
                  key={finish}
                  onClick={() => {
                    if (selectedFinishes.includes(finish)) {
                      setSelectedFinishes(selectedFinishes.filter(selectedFinish => selectedFinish !== finish));
                    } else {
                      setSelectedFinishes([...selectedFinishes, finish]);
                    }
                  }}
                  className={filterOptionClass(selectedFinishes.includes(finish))}
                >
                  {displayTag(finish)}
                </div>
              ))}
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
                {filterSummary(selectedYears)}
              </button>
            )}
            {!collapsedFilters.years && <div className="space-y-1">
              {yearOptions.map(year => (
                <div
                  key={year}
                  onClick={() => {
                    if (selectedYears.includes(year)) {
                      setSelectedYears(selectedYears.filter(y => y !== year));
                    } else {
                      setSelectedYears([...selectedYears, year]);
                    }
                  }}
                  className={filterOptionClass(selectedYears.includes(year))}
                >
                  {year}
                </div>
              ))}
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
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 rounded border border-border/60 bg-muted/30 p-1.5">
              <button
                type="button"
                onClick={pickRandomTracks}
                disabled={randomCandidates.length === 0}
                className={`min-h-9 rounded px-3 py-1.5 text-sm transition disabled:opacity-50 ${
                  randomTrackIds
                    ? 'bg-accent text-accent-foreground hover:bg-accent/90'
                    : 'bg-background text-muted-foreground hover:text-foreground'
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
                  className="min-h-9 rounded px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-background hover:text-foreground"
                >
                  All
                </button>
              )}
            </div>
            <div className="flex flex-1 flex-wrap items-center justify-end gap-3 sm:flex-none">
              <label className="text-foreground">Sort by:</label>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                className="min-h-11 flex-1 rounded border border-border bg-background p-2 text-foreground sm:flex-none"
              >
                <option value="name">Name</option>
                <option value="date">Date</option>
                <option value="adamsRating">Adam&apos;s Rating</option>
                <option value="userRating">User Rating</option>
              </select>
              <button
                onClick={() => setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')}
                className="min-h-11 rounded bg-accent px-4 py-2 text-accent-foreground hover:bg-accent/80"
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
        <div className="fixed bottom-3 left-3 right-3 z-50 rounded-lg border border-border bg-background/95 p-2 shadow-2xl backdrop-blur sm:bottom-4 sm:left-4 sm:right-4 sm:p-3 md:right-auto md:w-[min(360px,calc(100vw-2rem))]">
          <div className="flex flex-col gap-2 sm:gap-3 md:flex-row md:items-center">
            <div className="min-w-0 flex-1">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <h3 className="text-[10px] font-semibold uppercase leading-tight text-muted-foreground sm:text-xs">Now Playing</h3>
                  <button
                    type="button"
                    onClick={scrollToActiveCard}
                    className="block max-w-full truncate text-left text-sm font-semibold leading-tight hover:text-accent sm:text-base"
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
                className="mt-2 h-3 w-full cursor-pointer overflow-hidden rounded-full bg-muted"
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
                className="flex h-10 w-12 items-center justify-center rounded bg-accent text-accent-foreground transition hover:bg-accent/90"
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
