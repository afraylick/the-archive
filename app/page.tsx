'use client';

import { mutateRecording, type MetadataChanges } from '@/lib/recording-mutations';

import { Fragment, memo, type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import WaveSurfer from 'wavesurfer.js';
import { isValidWaveformCache, roundWaveformPeak, WAVEFORM_CACHE_VERSION, WAVEFORM_PEAK_LENGTH } from '@/lib/waveform';

interface AudioFile {
  id: string;
  projectId?: string;
  defaultVersionId?: string;
  variationType?: 'linked';
  linkedAt?: string;
  linkedBy?: string;
  uploadedBy?: string;
  uploadedByName?: string;
  interactionUserIds?: string[];
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

interface AudioCardProps {
  file: AudioFile;
  setFiles: React.Dispatch<React.SetStateAction<AudioFile[]>>;
  isActive: boolean;
  currentUser: ArchiveUser;
  accountUsers: ArchiveUser[];
  instrumentOptions: string[];
  vibeOptions: string[];
  collectionOptions: string[];
  linkableSongs: AudioFile[];
  shouldPreloadPlayback: boolean;
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

interface InboxMessage {
  id: string;
  recipientUserId: string;
  songId: string;
  songName: string;
  note: string;
  senderUserId: string;
  senderName: string;
  sentAt: string;
  readAt?: string;
}

type EndMode = 'repeat' | 'next' | 'stop';
type SortBy = 'random' | 'name' | 'date' | 'uploadDate' | 'adamsRatingRandom' | 'adamsRating' | 'userRating';
type FilterCategory = 'instruments' | 'vibes' | 'collections' | 'interactions' | 'finish' | 'years' | 'adamsRatings';
type FilterMode = 'none' | 'include' | 'exclude';
type FilterValue = string | number;

interface PlayerRegistryEntry {
  cardElement: HTMLDivElement;
  wavesurfer: WaveSurfer;
}

const FINISH_OPTIONS = ['Tracked', 'Recorder', 'Voice Memo'];
const INITIAL_RENDER_LIMIT = 30;
const RENDER_BATCH_SIZE = 30;
const USE_CACHED_WAVEFORM_RENDERING = true;
const MOBILE_PLACEHOLDER_WAVEFORM_PEAKS = [[0, 0]];
const MOBILE_PLACEHOLDER_DURATION = 0.001;
const MOBILE_WAVEFORM_MOUNT_DELAY = 180;
const MOBILE_WAVEFORM_IDLE_TIMEOUT = 900;
const VOL_BOOST_DB = 12;
const VOL_BOOST_GAIN = Math.pow(10, VOL_BOOST_DB / 20);
const MAX_VERSION_UPLOAD_BYTES = 30 * 1024 * 1024;
const VERSION_AUDIO_EXTENSIONS = new Set(['.aac', '.aif', '.aiff', '.flac', '.m4a', '.mp3', '.ogg', '.wav']);
const VERSION_AUDIO_ACCEPT = '.mp3,.wav,.m4a,.aac,.flac,.ogg,.aif,.aiff,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/aac,audio/flac,audio/ogg,audio/aiff,audio/x-aiff';
const TAG_LABELS: Record<string, string> = {
  'electric guitar': 'E. Guitar',
  'e. guitar': 'E. Guitar',
  'acoustic guitar': 'Acoustic',
};
let sharedAudioContext: AudioContext | null = null;
const tracksStartedFromWaveformClick = new Set<string>();

const getSharedAudioContext = () => {
  sharedAudioContext ??= new AudioContext();
  return sharedAudioContext;
};

const isMobilePlaybackDevice = () => {
  if (typeof navigator === 'undefined') return false;

  const userAgent = navigator.userAgent || '';
  return /Android|webOS|iPhone|iPad|iPod|Mobile/i.test(userAgent)
    || (/Macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1);
};

const getPlaybackAudioUrl = (id: string) => {
  const baseUrl = `/api/files/${encodeURIComponent(id)}/audio`;
  return isMobilePlaybackDevice() ? `${baseUrl}?format=mobile` : baseUrl;
};

const scheduleMobileWaveformMount = (callback: () => void) => {
  if (typeof window === 'undefined') return () => undefined;

  const idleWindow = window as Window & typeof globalThis & {
    requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };

  if (idleWindow.requestIdleCallback && idleWindow.cancelIdleCallback) {
    const idleId = idleWindow.requestIdleCallback(callback, { timeout: MOBILE_WAVEFORM_IDLE_TIMEOUT });
    return () => idleWindow.cancelIdleCallback?.(idleId);
  }

  const timeoutId = window.setTimeout(callback, MOBILE_WAVEFORM_MOUNT_DELAY);
  return () => window.clearTimeout(timeoutId);
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
const isCommonVersionAudioFile = (file: File) => {
  const extensionIndex = file.name.lastIndexOf('.');
  const extension = extensionIndex >= 0 ? file.name.slice(extensionIndex).toLowerCase() : '';
  return VERSION_AUDIO_EXTENSIONS.has(extension);
};
const getAdamRating = (file: AudioFile) => file.ratings?.adam || file.myRating || 0;
const getProjectId = (file: AudioFile) => file.projectId || file.id;
const findProjectForFileId = (projects: AudioFile[], fileId: string) => (
  projects.find(project => (
    project.id === fileId
    || project.uploads?.some(upload => upload.id === fileId)
  ))
);

const getInteractionUserIds = (project: AudioFile) => {
  const userIds = new Set<string>(Array.isArray(project.interactionUserIds) ? project.interactionUserIds : []);
  const versions = [project, ...(Array.isArray(project.uploads) ? project.uploads : [])];

  versions.forEach(version => {
    Object.entries(version.ratings || {}).forEach(([userId, rating]) => {
      if ((rating || 0) > 0) userIds.add(userId);
    });
    (Array.isArray(version.likedBy) ? version.likedBy : []).forEach(userId => userIds.add(userId));
    (Array.isArray(version.comments) ? version.comments : []).forEach(comment => {
      if (comment.userId) userIds.add(comment.userId);
    });
    if (version.projectId && version.uploadedBy) {
      userIds.add(version.uploadedBy);
    }
  });

  return Array.from(userIds);
};

const getDefaultVersion = (project: AudioFile) => {
  if (!project.defaultVersionId || project.defaultVersionId === project.id) return project;
  return project.uploads?.find(upload => upload.id === project.defaultVersionId) || project;
};

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

const replaceFileVersion = (projects: AudioFile[], updatedFile: Partial<AudioFile> & { id: string }) => projects.map(project => {
  if (project.id === updatedFile.id) {
    return { ...project, ...updatedFile, uploads: project.uploads };
  }
  if (!project.uploads?.some(upload => upload.id === updatedFile.id)) return project;
  return {
    ...project,
    uploads: project.uploads.map(upload => upload.id === updatedFile.id ? { ...upload, ...updatedFile } : upload),
  };
});

const formatDuration = (duration: number | undefined) => {
  if (!duration || duration <= 0 || !Number.isFinite(duration)) return '';

  const totalSeconds = Math.round(duration);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

const getWaveSurferPlayableDuration = (wavesurfer: WaveSurfer) => {
  const mediaDuration = wavesurfer.getMediaElement().duration;
  if (Number.isFinite(mediaDuration) && mediaDuration > 0) return mediaDuration;

  const wavesurferDuration = wavesurfer.getDuration();
  return Number.isFinite(wavesurferDuration) && wavesurferDuration > 0 ? wavesurferDuration : 0;
};

const seekWaveSurferToProgress = (wavesurfer: WaveSurfer, progress: number, fallbackDuration = 0) => {
  const safeProgress = Math.min(1, Math.max(0, progress));
  const duration = fallbackDuration || getWaveSurferPlayableDuration(wavesurfer);
  const time = duration * safeProgress;
  wavesurfer.setTime(time);
  if (duration > 0) {
    wavesurfer.getRenderer().renderProgress(safeProgress, wavesurfer.isPlaying());
  }

  return { duration, progress: safeProgress, time };
};

const renderWaveSurferTimelineProgress = (wavesurfer: WaveSurfer, currentTime: number, timelineDuration = 0) => {
  if (timelineDuration <= 0) return;
  wavesurfer.getRenderer().renderProgress(
    Math.min(1, Math.max(0, currentTime / timelineDuration)),
    wavesurfer.isPlaying()
  );
};

const setMediaSessionAction = (
  action: MediaSessionAction,
  handler: MediaSessionActionHandler | null
) => {
  try {
    navigator.mediaSession.setActionHandler(action, handler);
  } catch {
    // Browsers expose different subsets of Media Session actions.
  }
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
  return rating > 0 ? 'text-[#3680e9]' : 'text-[#6e7273]/70';
};

const adamRatingColorClass = 'text-[#3680e9]';
const userRatingColorClass = 'text-[#67974f]';
const emptyRatingColorClass = 'text-[#6e7273]/70';
const getResponsiveWaveformHeight = () => (
  typeof window !== 'undefined' && window.innerWidth < 640 ? 176 : 92
);

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

const SidebarIcon = ({ name }: { name: 'instruments' | 'vibes' | 'collections' | 'interactions' | 'finish' | 'years' | 'rating' | 'liked' | 'untagged' | 'search' | 'plus' }) => {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeWidth: 1.9,
  };

  return (
    <svg className="h-5 w-5 shrink-0 text-muted-foreground" viewBox={name === 'instruments' ? '0 0 512 512' : '0 0 24 24'} aria-hidden="true">
      {name === 'instruments' && (
        <path
          fill="currentColor"
          stroke="none"
          d="M502.7 39.02L473 9.37c-12.5-12.5-32.74-12.49-45.24 .0106l-46.24 46.37c-3.875 3.875-6.848 8.506-8.598 13.76l-12.19 36.51L284.5 182.3C272.4 173.5 259 166.5 244.4 163.1C211 155.4 177.4 162.3 154.5 185.1C145.3 194.5 138.3 206 134.3 218.6C128.3 237.1 111.1 251.3 92.14 253C68.52 255.4 46.39 264.5 29.52 281.5c-45.62 45.5-37.38 127.5 18.12 183c55.37 55.38 137.4 63.51 182.9 18c16.1-16.88 26.25-38.85 28.5-62.72c1.75-18.75 15.84-36.16 34.47-42.16c12.5-3.875 24.03-10.87 33.4-20.25c22.87-22.88 29.75-56.38 21.1-89.76c-3.375-14.63-10.39-27.99-19.14-40.11l76.25-76.26l36.53-12.17c5.125-1.75 9.894-4.715 13.77-8.59l46.36-46.29C515.2 71.72 515.2 51.52 502.7 39.02zM208 352c-26.5 0-48-21.5-48-48c0-26.5 21.5-48 48-48s47.1 21.5 47.1 48C256 330.5 234.5 352 208 352z"
        />
      )}
      {name === 'vibes' && (
        <>
          <path {...common} d="M3 8c3-3 6 3 9 0s6 3 9 0" />
          <path {...common} d="M3 14c3-3 6 3 9 0s6 3 9 0" />
          <path {...common} d="M3 20c3-3 6 3 9 0s6 3 9 0" />
        </>
      )}
      {name === 'collections' && <path {...common} d="M3.5 7.5h7l2 2H20.5v10H3.5z" />}
      {name === 'interactions' && (
        <>
          <path {...common} d="M8.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
          <path {...common} d="M2.5 20c.5-4 2.5-6 6-6s5.5 2 6 6" />
          <path {...common} d="m16.5 7 1.5 1.5L21.5 5" />
          <path {...common} d="M16 13.5h5M18.5 11v5" />
        </>
      )}
      {name === 'finish' && (
        <>
          <path {...common} d="M12 3.5 19.5 9 12 20.5 4.5 9z" />
          <path {...common} d="M4.5 9h15" />
          <path {...common} d="m8.5 9 3.5 11.5L15.5 9" />
          <path {...common} d="M8.5 9 12 3.5 15.5 9" />
          <path {...common} d="M19.5 3.5v3" />
          <path {...common} d="M18 5h3" />
        </>
      )}
      {name === 'years' && (
        <>
          <path {...common} d="M5 5h14v16H5z" />
          <path {...common} d="M8 3v4M16 3v4M5 10h14" />
        </>
      )}
      {name === 'rating' && <path {...common} d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1L12 16.9 6.6 19.8l1-6.1-4.4-4.3 6.1-.9z" />}
      {name === 'liked' && <path {...common} d="M20.8 8.5c0 5-8.8 10-8.8 10S3.2 13.5 3.2 8.5A4.4 4.4 0 0 1 11 5.7a4.4 4.4 0 0 1 8.8 2.8Z" />}
      {name === 'untagged' && <path {...common} d="M4 4h8.5L20 11.5 11.5 20 4 12.5z" />}
      {name === 'search' && <path {...common} d="m21 21-4.4-4.4M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z" />}
      {name === 'plus' && <path {...common} d="M12 5v14M5 12h14" />}
    </svg>
  );
};

const SidebarChevron = ({ open }: { open: boolean }) => (
  <svg className={`h-5 w-5 shrink-0 text-muted-foreground transition ${open ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m6 9 6 6 6-6" />
  </svg>
);

const AudioCard = memo(function AudioCard({
  file: project,
  setFiles,
  isActive,
  currentUser,
  accountUsers,
  instrumentOptions,
  vibeOptions,
  collectionOptions,
  linkableSongs,
  shouldPreloadPlayback,
  onReady,
  onPlay,
  onPause,
  onStop,
  onDestroy,
}: AudioCardProps) {
  const [selectedFileId, setSelectedFileId] = useState(() => getDefaultVersion(project).id);
  const file = selectedFileId === project.id
    ? project
    : project.uploads?.find(upload => upload.id === selectedFileId) || project;
  const waveformRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const mediaSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const [hoveredAdamRating, setHoveredAdamRating] = useState(0);
  const [hoveredUserRating, setHoveredUserRating] = useState(0);
  const [openTagPicker, setOpenTagPicker] = useState<'instruments' | 'vibes' | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(project.name);
  const [showVersions, setShowVersions] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [showCollections, setShowCollections] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showLinkSearch, setShowLinkSearch] = useState(false);
  const [linkSearchQuery, setLinkSearchQuery] = useState('');
  const [linkError, setLinkError] = useState('');
  const [isLinkingSong, setIsLinkingSong] = useState(false);
  const [showSendPanel, setShowSendPanel] = useState(false);
  const [selectedRecipientId, setSelectedRecipientId] = useState('');
  const [sendNote, setSendNote] = useState('');
  const [sendError, setSendError] = useState('');
  const [sendSuccess, setSendSuccess] = useState('');
  const [isSendingSong, setIsSendingSong] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadNotes, setUploadNotes] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const uploadInputRef = useRef<HTMLInputElement>(null);
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
  const [hasStartedPlayback, setHasStartedPlayback] = useState(() => tracksStartedFromWaveformClick.has(file.id));
  const [isCardPlaying, setIsCardPlaying] = useState(false);
  const [duration, setDuration] = useState(file.waveformDuration || 0);
  const [currentTime, setCurrentTime] = useState(0);
  const durationRef = useRef(file.waveformDuration || 0);
  const waveformHeightRef = useRef(getResponsiveWaveformHeight());
  const lastPlaybackUiSyncRef = useRef(0);
  const canRenderCachedWaveform = USE_CACHED_WAVEFORM_RENDERING && hasCachedWaveform(file);
  const latestFileRef = useRef(file);
  const playWhenReadyRef = useRef(false);
  const audioPlayableRef = useRef(false);
  const pendingPlaybackRef = useRef<{ progress: number; currentTime: number } | null>(null);

  useEffect(() => {
    latestFileRef.current = file;
  }, [file]);

  useEffect(() => {
    if (showLinkSearch) {
      const desktopInput = document.getElementById(`link-song-desktop-${project.id}`) as HTMLInputElement | null;
      const mobileInput = document.getElementById(`link-song-mobile-${project.id}`) as HTMLInputElement | null;
      const visibleInput = desktopInput?.offsetParent ? desktopInput : mobileInput;
      visibleInput?.focus();
    }
  }, [project.id, showLinkSearch]);

  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);

  const selectFileVersion = (nextFile: AudioFile) => {
    wavesurferRef.current?.pause();
    setSelectedFileId(nextFile.id);
    setNoteText(getNoteText(nextFile));
    setNewComment('');
    setCommentTimecode('');
    setCurrentTime(0);
    setDuration(nextFile.waveformDuration || 0);
    durationRef.current = nextFile.waveformDuration || 0;
    setHasStartedPlayback(tracksStartedFromWaveformClick.has(nextFile.id));
    setIsCardPlaying(false);
  };

  useEffect(() => {
    const cardElement = cardRef.current;
    if (!cardElement || shouldMountWaveform || isActive || shouldPreloadPlayback) return;

    let cancelScheduledMount: (() => void) | null = null;
    const mountWaveform = () => {
      cancelScheduledMount = null;
      setShouldMountWaveform(true);
    };

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          observer.disconnect();
          if (isMobilePlaybackDevice()) {
            cancelScheduledMount = scheduleMobileWaveformMount(mountWaveform);
          } else {
            mountWaveform();
          }
        }
      },
      { rootMargin: isMobilePlaybackDevice() ? '120px 0px' : '260px 0px' }
    );

    observer.observe(cardElement);
    return () => {
      observer.disconnect();
      cancelScheduledMount?.();
    };
  }, [isActive, shouldMountWaveform, shouldPreloadPlayback]);

  const shouldRenderWaveform = shouldMountWaveform || isActive || shouldPreloadPlayback;

  const playFromProgress = useCallback((progress: number) => {
    const wavesurfer = wavesurferRef.current;
    if (!wavesurfer) return;

    wavesurfer.getMediaElement().preload = 'auto';
    const timelineDuration = hasCachedWaveform(latestFileRef.current)
      ? latestFileRef.current.waveformDuration || 0
      : durationRef.current || 0;
    const seekState = seekWaveSurferToProgress(
      wavesurfer,
      progress,
      timelineDuration
    );

    tracksStartedFromWaveformClick.add(latestFileRef.current.id);
    setHasStartedPlayback(true);
    setDuration(seekState.duration);
    setCurrentTime(seekState.time);

    if (!audioPlayableRef.current) {
      pendingPlaybackRef.current = { progress: seekState.progress, currentTime: seekState.time };
      return;
    }

    pendingPlaybackRef.current = null;
    void wavesurfer.play();
  }, []);

  const handleTagRowWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (element.scrollWidth <= element.clientWidth) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (delta === 0) return;
    event.preventDefault();
    element.scrollLeft += delta;
  };

  const handleTagRowPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (element.scrollWidth <= element.clientWidth) return;
    const startX = event.clientX;
    const startScrollLeft = element.scrollLeft;

    element.setPointerCapture(event.pointerId);
    element.dataset.draggingTags = 'true';

    const handleMove = (moveEvent: PointerEvent) => {
      element.scrollLeft = startScrollLeft - (moveEvent.clientX - startX);
    };
    const handleEnd = () => {
      element.dataset.draggingTags = 'false';
      element.removeEventListener('pointermove', handleMove);
      element.removeEventListener('pointerup', handleEnd);
      element.removeEventListener('pointercancel', handleEnd);
    };

    element.addEventListener('pointermove', handleMove);
    element.addEventListener('pointerup', handleEnd);
    element.addEventListener('pointercancel', handleEnd);
  };

  useEffect(() => {
    if (!shouldRenderWaveform) return;
    if (!waveformRef.current || !cardRef.current) return;

    audioPlayableRef.current = false;
    pendingPlaybackRef.current = null;
    const cachedPeaks = canRenderCachedWaveform ? latestFileRef.current.waveformPeaks : undefined;
    const cachedDuration = canRenderCachedWaveform ? latestFileRef.current.waveformDuration : undefined;
    const useMobileStreamingFallback = !canRenderCachedWaveform && isMobilePlaybackDevice();
    const fallbackPeaks = useMobileStreamingFallback ? MOBILE_PLACEHOLDER_WAVEFORM_PEAKS : undefined;
    const fallbackDuration = useMobileStreamingFallback ? MOBILE_PLACEHOLDER_DURATION : undefined;

    const wavesurfer = WaveSurfer.create({
      container: waveformRef.current,
      waveColor: '#727479',
      progressColor: tracksStartedFromWaveformClick.has(latestFileRef.current.id) ? '#525252' : '#727479',
      cursorWidth: tracksStartedFromWaveformClick.has(latestFileRef.current.id) ? 1 : 0,
      cursorColor: '#3680e9',
      height: waveformHeightRef.current,
      interact: false,
      backend: 'MediaElement',
      url: getPlaybackAudioUrl(latestFileRef.current.id),
      peaks: cachedPeaks || fallbackPeaks,
      duration: cachedDuration || fallbackDuration,
    });

    wavesurferRef.current = wavesurfer;
    onReady(latestFileRef.current, cardRef.current, wavesurfer);
    const mediaElement = wavesurfer.getMediaElement();
    mediaElement.preload = isMobilePlaybackDevice() ? 'metadata' : 'auto';
    mediaElement.setAttribute('playsinline', '');
    let appliedMobileMetadataDuration = false;

    const applyMobileMetadataDuration = () => {
      if (!useMobileStreamingFallback || appliedMobileMetadataDuration) return;

      const mediaDuration = mediaElement.duration;
      if (!Number.isFinite(mediaDuration) || mediaDuration <= 0) return;

      appliedMobileMetadataDuration = true;
      durationRef.current = mediaDuration;
      setDuration(mediaDuration);
      wavesurfer.setOptions({
        peaks: MOBILE_PLACEHOLDER_WAVEFORM_PEAKS,
        duration: mediaDuration,
      });
      renderWaveSurferTimelineProgress(wavesurfer, mediaElement.currentTime || 0, mediaDuration);
    };

    const handleCanPlay = () => {
      applyMobileMetadataDuration();
      audioPlayableRef.current = true;
      const pendingPlayback = pendingPlaybackRef.current;
      if (!pendingPlayback) return;

      pendingPlaybackRef.current = null;
      const timelineDuration = hasCachedWaveform(latestFileRef.current)
        ? latestFileRef.current.waveformDuration || 0
        : durationRef.current || 0;
      const seekState = seekWaveSurferToProgress(
        wavesurfer,
        pendingPlayback.progress,
        timelineDuration
      );
      setDuration(seekState.duration);
      setCurrentTime(seekState.time);
      void wavesurfer.play();
    };

    const handlePlay = () => {
      if (cardRef.current) {
        onPlay(latestFileRef.current, cardRef.current, wavesurfer);
      }
      setHasStartedPlayback(true);
      setIsCardPlaying(true);
    };
    const handlePause = () => {
      setIsCardPlaying(false);
      onPause(latestFileRef.current, wavesurfer);
    };
    const handleFinish = () => {
      setIsCardPlaying(false);
      onStop(latestFileRef.current, wavesurfer);
    };
    const handleError = (error: Error) => console.error('WaveSurfer error for', latestFileRef.current.id, error);
    const handleReady = (readyDuration: number) => {
      const timelineDuration = hasCachedWaveform(latestFileRef.current)
        ? latestFileRef.current.waveformDuration || readyDuration
        : readyDuration;
      setDuration(timelineDuration);
      setCurrentTime(wavesurfer.getCurrentTime());
      if (playWhenReadyRef.current) {
        playWhenReadyRef.current = false;
        playFromProgress(0);
      }
    };
    const syncPlaybackUi = (time: number, force = false) => {
      if (document.hidden && !force) return;

      const now = performance.now();
      if (!force && now - lastPlaybackUiSyncRef.current < 250) return;

      lastPlaybackUiSyncRef.current = now;
      setCurrentTime(time);
      renderWaveSurferTimelineProgress(
        wavesurfer,
        time,
        hasCachedWaveform(latestFileRef.current) ? latestFileRef.current.waveformDuration || 0 : durationRef.current || 0
      );
    };
    const handleTimeUpdate = (time: number) => syncPlaybackUi(time);
    const handleSeeking = (time: number) => syncPlaybackUi(time, true);
    const handleWaveformWrapperClick = (event: MouseEvent) => {
      const wrapper = wavesurfer.getWrapper();
      const rect = wrapper.getBoundingClientRect();
      const alreadyStarted = tracksStartedFromWaveformClick.has(latestFileRef.current.id);
      const progress = alreadyStarted && rect.width > 0
        ? (event.clientX - rect.left) / rect.width
        : 0;

      playFromProgress(progress);
    };
    const handleDecode = async (duration: number) => {
      const latestFile = latestFileRef.current;
      setDuration(duration);
      if (hasCachedWaveform(latestFile) || duration <= 0) return;

      const decodedData = wavesurfer.getDecodedData();
      if (!decodedData) return;

      const waveformPeaks = createWaveformPeaks(decodedData);
      if (!waveformPeaks[0]?.length) return;

      try {
        const changes = await mutateRecording<AudioFile>(latestFile.id, {
          operation: 'waveform',
          waveform: { waveformPeaks, waveformDuration: duration, waveformCacheVersion: WAVEFORM_CACHE_VERSION },
        });
        setFiles(prev => replaceFileVersion(prev, { id: latestFile.id, ...changes }));
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
    wavesurfer.on('seeking', handleSeeking);
    wavesurfer.on('decode', handleDecode);
    wavesurfer.getWrapper().addEventListener('click', handleWaveformWrapperClick);
    mediaElement.addEventListener('canplay', handleCanPlay);
    mediaElement.addEventListener('loadedmetadata', handleCanPlay);

    return () => {
      wavesurfer.getWrapper().removeEventListener('click', handleWaveformWrapperClick);
      mediaElement.removeEventListener('canplay', handleCanPlay);
      mediaElement.removeEventListener('loadedmetadata', handleCanPlay);
      onDestroy(latestFileRef.current, wavesurfer);
      gainNodeRef.current?.disconnect();
      gainNodeRef.current = null;
      mediaSourceRef.current?.disconnect();
      mediaSourceRef.current = null;
      wavesurfer.destroy();
      wavesurferRef.current = null;
      audioPlayableRef.current = false;
      pendingPlaybackRef.current = null;
      setIsCardPlaying(false);
    };
  }, [canRenderCachedWaveform, file.id, onDestroy, onPause, onPlay, onReady, onStop, playFromProgress, setFiles, shouldRenderWaveform, waveformRefreshKey]);

  useEffect(() => {
    const mediaElement = wavesurferRef.current?.getMediaElement();
    if (!mediaElement) return;

    mediaElement.preload = isMobilePlaybackDevice() && !shouldPreloadPlayback && !isActive ? 'metadata' : 'auto';
  }, [isActive, shouldPreloadPlayback]);

  useEffect(() => {
    if (!volumeBoostConfirming) return;

    const timeoutId = window.setTimeout(() => setVolumeBoostConfirming(false), 2500);
    return () => window.clearTimeout(timeoutId);
  }, [volumeBoostConfirming]);

  useEffect(() => {
    wavesurferRef.current?.setOptions({
      progressColor: hasStartedPlayback ? (isActive ? '#3680e9' : '#525252') : '#727479',
      cursorWidth: hasStartedPlayback ? 1 : 0,
    });
  }, [hasStartedPlayback, isActive]);

  useEffect(() => {
    if (!shouldRenderWaveform || !waveformRef.current) return;

    let resizeTimer: number | undefined;
    const updateResponsiveWaveformSize = () => {
      if (resizeTimer) {
        window.clearTimeout(resizeTimer);
      }
      resizeTimer = window.setTimeout(() => {
        const nextHeight = getResponsiveWaveformHeight();
        if (nextHeight !== waveformHeightRef.current) {
          waveformHeightRef.current = nextHeight;
          wavesurferRef.current?.setOptions({ height: nextHeight });
        }
      }, 100);
    };

    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updateResponsiveWaveformSize)
      : undefined;
    resizeObserver?.observe(waveformRef.current);
    window.addEventListener('resize', updateResponsiveWaveformSize);

    return () => {
      if (resizeTimer) {
        window.clearTimeout(resizeTimer);
      }
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateResponsiveWaveformSize);
    };
  }, [shouldRenderWaveform]);

  const handleUserRatingChange = async (newRating: number, userId = currentUser.id) => {
    const res = await fetch(`/api/files/${encodeURIComponent(file.id)}/rating`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: newRating, userId }),
    });

    if (!res.ok) return;

    const ratingData = await res.json() as Pick<AudioFile, 'ratings' | 'myRating' | 'userRating' | 'ratingUpdatedAt'>;
    const updatedFile = { id: file.id, ...ratingData };
    setFiles(prev => replaceFileVersion(prev, updatedFile));
  };

  const toggleLike = async () => {
    const res = await fetch(`/api/files/${encodeURIComponent(file.id)}/like`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ liked: !file.liked }),
    });

    if (!res.ok) return;

    const data = await res.json() as { liked: boolean; likedBy: string[] };
    setFiles(prev => replaceFileVersion(prev, { id: file.id, ...data }));
  };

  const updateFile = async (id: string, changes: MetadataChanges) => {
    const committed = await mutateRecording<AudioFile>(id, { operation: 'metadata', changes });
    setFiles(prev => replaceFileVersion(prev, { id, ...committed }));
  };

  const saveRename = async () => {
    const nextName = renameDraft.trim();
    if (!nextName || nextName === project.name) {
      setRenameDraft(project.name);
      setIsRenaming(false);
      return;
    }

    try {
      await updateFile(project.id, { name: nextName });
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
    await updateFile(file.id, category === 'instruments' ? { instruments: nextInstruments } : { vibes: nextVibes });
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
    const updatedFile = { id: file.id, collections: data.collections };
    setFiles(prev => replaceFileVersion(prev, updatedFile));
  };

  const saveNotes = async () => {
    const trimmedNote = noteText.trim();
    await updateFile(file.id, { notes: trimmedNote ? noteText : '' });
  };

  const seekAndPlayComment = (timestamp: number) => {
    if (!wavesurferRef.current || !markerDuration) return;

    playFromProgress(timestamp / markerDuration);
  };

  const handleCardPlayButton = () => {
    const wavesurfer = wavesurferRef.current;
    if (!wavesurfer) {
      playWhenReadyRef.current = true;
      tracksStartedFromWaveformClick.add(file.id);
      setHasStartedPlayback(true);
      setShouldMountWaveform(true);
      return;
    }

    if (wavesurfer.isPlaying()) {
      wavesurfer.pause();
      return;
    }

    if (!tracksStartedFromWaveformClick.has(file.id)) {
      playFromProgress(0);
      return;
    }
    playFromProgress((wavesurfer.getCurrentTime() || 0) / (
      hasCachedWaveform(file) ? file.waveformDuration || 1 : durationRef.current || wavesurfer.getDuration() || 1
    ));
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
    setFiles(prev => replaceFileVersion(prev, { id: file.id, comments: data.comments }));
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
    setFiles(prev => replaceFileVersion(prev, { id: file.id, comments: data.comments }));
  };

  const uploadVersion = async () => {
    if (!uploadFile || isUploading) return;
    if (!isCommonVersionAudioFile(uploadFile)) {
      setUploadError('Use an MP3, WAV, M4A, AAC, FLAC, OGG, or AIFF audio file');
      return;
    }
    if (uploadFile.size > MAX_VERSION_UPLOAD_BYTES) {
      setUploadError('Audio uploads are limited to 30 MB');
      return;
    }

    setIsUploading(true);
    setUploadError('');
    const formData = new FormData();
    formData.set('file', uploadFile);
    formData.set('notes', uploadNotes);

    try {
      const res = await fetch(`/api/files/${encodeURIComponent(project.id)}/uploads`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json() as { upload?: AudioFile; error?: string };
      if (!res.ok || !data.upload) {
        setUploadError(data.error || 'Upload failed');
        return;
      }

      const uploadedVersion = data.upload;
      setFiles(prev => prev.map(song => song.id === project.id
        ? { ...song, uploads: [uploadedVersion, ...(song.uploads || [])] }
        : song
      ));
      setUploadFile(null);
      setUploadNotes('');
      setShowUpload(false);
      setShowVersions(false);
      if (uploadInputRef.current) uploadInputRef.current.value = '';
    } catch {
      setUploadError('Upload failed. Please try again.');
    } finally {
      setIsUploading(false);
    }
  };

  const linkSearchResults = useMemo(() => {
    const query = linkSearchQuery.trim().toLowerCase();
    if (!query) return [];

    return linkableSongs
      .filter(song => song.id !== project.id)
      .filter(song => (
        song.name.toLowerCase().includes(query)
        || song.originalName?.toLowerCase().includes(query)
      ))
      .sort(compareByName)
      .slice(0, 8);
  }, [linkSearchQuery, linkableSongs, project.id]);

  const recipientUsers = useMemo(() => (
    accountUsers
      .filter(user => !user.isAdmin)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  ), [accountUsers]);

  const linkSongToProject = async (targetProject: AudioFile) => {
    if (isLinkingSong) return;

    setIsLinkingSong(true);
    setLinkError('');
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(project.id)}/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetProjectId: targetProject.id }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) {
        setLinkError(data.error || 'Failed to link song');
        return;
      }

      const filesRes = await fetch('/api/files');
      if (!filesRes.ok) throw new Error('Failed to reload songs');
      setFiles(await filesRes.json() as AudioFile[]);
      setShowLinkSearch(false);
      setLinkSearchQuery('');
    } catch {
      setLinkError('Failed to link song. Please try again.');
    } finally {
      setIsLinkingSong(false);
    }
  };

  const sendSongToInbox = async () => {
    if (!selectedRecipientId || isSendingSong) return;

    setIsSendingSong(true);
    setSendError('');
    setSendSuccess('');
    try {
      const res = await fetch('/api/inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipientUserId: selectedRecipientId,
          songId: project.id,
          note: sendNote,
        }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) {
        setSendError(data.error || 'Failed to send song');
        return;
      }

      const recipientName = recipientUsers.find(user => user.id === selectedRecipientId)?.name || 'user';
      setSendSuccess(`Sent to ${recipientName}`);
      setSelectedRecipientId('');
      setSendNote('');
    } catch {
      setSendError('Failed to send song. Please try again.');
    } finally {
      setIsSendingSong(false);
    }
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
      const serverRes = await fetch(`/api/files/${encodeURIComponent(latestFile.id)}/waveform`, {
        method: 'POST',
      });

      if (serverRes.ok) {
        const waveformData = await serverRes.json() as WaveformGenerationResponse;
        const updatedFile = {
          id: latestFile.id,
          waveformPeaks: waveformData.waveformPeaks,
          waveformDuration: waveformData.waveformDuration,
          waveformCacheVersion: waveformData.waveformCacheVersion,
        };

        setDuration(waveformData.waveformDuration);
        setCurrentTime(0);
        setFiles(prev => replaceFileVersion(prev, updatedFile));
        setShouldMountWaveform(true);
        setWaveformRefreshKey(prev => prev + 1);
        return;
      }

      const res = await fetch(`/api/files/${encodeURIComponent(latestFile.id)}/audio`);
      if (!res.ok) throw new Error('Failed to load audio file');

      const audioContext = getSharedAudioContext();
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      const audioBuffer = await audioContext.decodeAudioData(await res.arrayBuffer());
      const waveformPeaks = createWaveformPeaks(audioBuffer);
      const changes = await mutateRecording<AudioFile>(latestFile.id, {
        operation: 'waveform',
        waveform: { waveformPeaks, waveformDuration: audioBuffer.duration, waveformCacheVersion: WAVEFORM_CACHE_VERSION },
      });

      setDuration(audioBuffer.duration);
      setCurrentTime(0);
      setFiles(prev => replaceFileVersion(prev, { id: latestFile.id, ...changes }));
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
  const uploads = Array.isArray(project.uploads) ? project.uploads : [];
  const selectedUploadDate = formatShortDate(file.uploadedAt);
  const selectedLinkedDate = formatShortDate(file.linkedAt);
  const adminName = accountUsers.find(user => user.id === 'adam')?.name || 'Admin';
  const accountNamesById = new Map(accountUsers.map(user => [user.id, user.name]));
  const selectedVersionMetadata = file.projectId
    ? file.variationType === 'linked'
      ? `Linked variation: ${file.name}${selectedLinkedDate ? ` · added ${selectedLinkedDate}` : ''}`
      : `Uploaded by ${(file.uploadedBy ? accountNamesById.get(file.uploadedBy) : '') || file.uploadedByName || file.uploadedBy || 'Unknown'}${selectedUploadDate ? ` on ${selectedUploadDate}` : ''}`
    : '';
  const adamRating = file.ratings?.adam || file.myRating || 0;
  const displayedAdamRating = hoveredAdamRating || adamRating;
  const currentUserRating = file.ratings?.[currentUser.id] || file.userRating || 0;
  const displayedUserRating = hoveredUserRating || currentUserRating;
  const getCommentDisplayName = (comment: AudioComment) => accountNamesById.get(comment.userId) || comment.userName;
  const otherUserRatings = currentUser.isAdmin
    ? accountUsers
        .filter(user => user.id !== 'adam')
        .map(user => ({ user, rating: file.ratings?.[user.id] || 0 }))
        .filter(({ rating }) => rating > 0)
    : [];
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
  const durationLabel = formatDuration(duration || file.waveformDuration);
  const playheadLabel = formatDuration(currentTime) || '0:00';
  const timeLabel = hasStartedPlayback ? `${playheadLabel}/${durationLabel}` : durationLabel;
  const markerDuration = duration || file.waveformDuration || 0;
  const highlightedCommentId = useMemo(() => {
    const closestComment = comments.reduce<AudioComment | null>((closest, comment) => {
      if (typeof comment.timestamp !== 'number' || comment.timestamp > currentTime) return closest;
      if (!closest || typeof closest.timestamp !== 'number' || comment.timestamp >= closest.timestamp) return comment;
      return closest;
    }, null);

    return closestComment ? closestComment.id : null;
  }, [comments, currentTime]);

  const renderLinkSearchPanel = (
    responsiveClassName: string,
    inputId: string,
  ) => (
    <div className={`absolute z-[180] w-[min(22rem,calc(100vw-2rem))] rounded-md border border-border/80 bg-[#0d1419]/[0.99] p-2 shadow-2xl shadow-black/55 backdrop-blur ${responsiveClassName}`}>
      <label className="sr-only" htmlFor={inputId}>Find a song to link to</label>
      <input
        id={inputId}
        type="search"
        value={linkSearchQuery}
        onChange={(event) => {
          setLinkSearchQuery(event.target.value);
          setLinkError('');
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setShowLinkSearch(false);
            setLinkSearchQuery('');
            setLinkError('');
          }
        }}
        placeholder="Find the main song…"
        className="w-full rounded border border-border/75 bg-background/85 px-2.5 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/65 focus:border-accent/55"
      />
      {linkSearchQuery.trim() && (
        <div className="mt-1 max-h-60 overflow-y-auto">
          {linkSearchResults.length > 0 ? linkSearchResults.map(song => (
            <button
              key={song.id}
              type="button"
              disabled={isLinkingSong}
              onClick={() => void linkSongToProject(song)}
              className="flex w-full items-center justify-between gap-3 rounded px-2.5 py-2 text-left transition hover:bg-muted/45 disabled:opacity-50"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-foreground">{song.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {song.uploads?.length ? `${song.uploads.length + 1} variations` : 'Main song'}
                </span>
              </span>
              <svg className="h-3.5 w-3.5 shrink-0 text-accent/80" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1m3.1 5.8a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20l1.1-1.1" />
              </svg>
            </button>
          )) : (
            <p className="px-2.5 py-3 text-sm text-muted-foreground">No matching songs</p>
          )}
        </div>
      )}
      {linkError && <p className="mt-1 px-1 text-xs text-red-300">{linkError}</p>}
    </div>
  );

  const renderSendPanel = (responsiveClassName: string) => (
    <div className={`absolute z-[180] w-[min(22rem,calc(100vw-2rem))] rounded-md border border-border/80 bg-[#0d1419]/[0.99] p-2 shadow-2xl shadow-black/55 backdrop-blur ${responsiveClassName}`}>
      <p className="px-1 pb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Send to inbox</p>
      <div className="max-h-40 space-y-1 overflow-y-auto">
        {recipientUsers.length > 0 ? recipientUsers.map(user => (
          <button
            key={user.id}
            type="button"
            onClick={() => {
              setSelectedRecipientId(user.id);
              setSendError('');
              setSendSuccess('');
            }}
            className={`flex w-full items-center justify-between rounded border px-2.5 py-2 text-left text-sm transition ${
              selectedRecipientId === user.id
                ? 'border-accent/55 bg-accent/10 text-foreground'
                : 'border-transparent text-muted-foreground hover:bg-muted/45 hover:text-foreground'
            }`}
            aria-pressed={selectedRecipientId === user.id}
          >
            <span className="truncate">{user.name}</span>
            <span className={`h-2 w-2 shrink-0 rounded-full ${selectedRecipientId === user.id ? 'bg-accent' : 'bg-border'}`} />
          </button>
        )) : (
          <p className="px-2.5 py-3 text-sm text-muted-foreground">No users available</p>
        )}
      </div>
      <label className="mt-2 block text-xs text-muted-foreground">
        Note <span className="text-muted-foreground/60">(optional)</span>
        <textarea
          value={sendNote}
          onChange={(event) => {
            setSendNote(event.target.value.slice(0, 2000));
            setSendError('');
            setSendSuccess('');
          }}
          rows={3}
          placeholder="Add a note for this song…"
          className="mt-1 w-full resize-none rounded border border-border/75 bg-background/85 px-2.5 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/65 focus:border-accent/55"
        />
      </label>
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className={`min-w-0 truncate text-xs ${sendError ? 'text-red-300' : 'text-accent'}`}>
          {sendError || sendSuccess}
        </span>
        <button
          type="button"
          onClick={() => void sendSongToInbox()}
          disabled={!selectedRecipientId || isSendingSong}
          className="shrink-0 rounded bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {isSendingSong ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );

  return (
    <div ref={cardRef} className={`audio-card relative overflow-visible border-b border-border/70 bg-[#10181e]/92 px-3 py-3 scroll-mt-24 transition hover:bg-[#11191f] sm:px-4 md:px-6 ${showVersions || showLinkSearch || showSendPanel ? 'z-[100]' : 'z-0'}`}>
      <div className="grid gap-3 md:grid-cols-[2.75rem_minmax(0,1fr)] md:items-start md:gap-3">
        <div className="relative z-40 order-1 flex items-center justify-between gap-3 md:hidden">
          <span className="truncate text-[11px] font-light text-muted-foreground opacity-75 md:hidden" title={file.projectId ? selectedVersionMetadata : `Recorded ${formatCreatedDate(file)}`}>
            {file.projectId ? selectedVersionMetadata : [finish ? displayTag(finish) : '', file.year || 'N/A'].filter(Boolean).join(' - ')}
          </span>
          <button
            type="button"
            onClick={handleCardPlayButton}
            className={`relative z-40 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition md:hidden ${
              isActive
                ? 'border-accent/60 bg-accent/15 text-accent'
                : 'border-border/70 bg-background/55 text-foreground hover:border-accent/45 hover:text-accent'
            }`}
            aria-label={isCardPlaying ? `Pause ${file.name}` : `Play ${file.name}`}
            title={isCardPlaying ? `Pause ${file.name}` : `Play ${file.name}`}
          >
            {isCardPlaying ? (
              <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M5.5 4.5h3v11h-3zm6 0h3v11h-3z" />
              </svg>
            ) : (
              <svg className="ml-0.5 h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M7 4.5v11l9-5.5-9-5.5z" />
              </svg>
            )}
          </button>
        </div>

        <div className="relative z-40 order-2 hidden md:flex md:justify-center md:pt-0">
          <button
            type="button"
            onClick={handleCardPlayButton}
            className={`relative z-40 flex h-9 w-9 items-center justify-center rounded-full border transition ${
              isActive
                ? 'border-accent/60 bg-accent/15 text-accent'
                : 'border-border/70 bg-background/55 text-foreground hover:border-accent/45 hover:text-accent'
            }`}
            aria-label={isCardPlaying ? `Pause ${file.name}` : `Play ${file.name}`}
            title={isCardPlaying ? `Pause ${file.name}` : `Play ${file.name}`}
          >
            {isCardPlaying ? (
              <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M5.5 4.5h3v11h-3zm6 0h3v11h-3z" />
              </svg>
            ) : (
              <svg className="ml-0.5 h-4 w-4" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M7 4.5v11l9-5.5-9-5.5z" />
              </svg>
            )}
          </button>
        </div>

        <div className="relative order-3 min-w-0">
          <div className={`relative flex min-w-0 items-start gap-2 md:pr-44 ${showVersions ? 'z-[120]' : 'z-20'}`}>
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
                      setRenameDraft(project.name);
                      setIsRenaming(false);
                    }
                  }}
                  className="w-full rounded border border-accent/50 bg-background/80 px-2 py-1 text-base font-semibold text-foreground outline-none"
                  autoFocus
                />
              ) : (
                <div className="relative inline-flex max-w-full min-w-0 items-baseline gap-2 rounded bg-[#0b0f14]/25 px-2 py-0.5 shadow-[0_0_9px_rgba(11,15,20,0.22)] backdrop-blur-[1px]">
                  {uploads.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => setShowVersions(prev => !prev)}
                      className="group inline-flex min-w-0 items-center gap-1.5 text-left"
                      aria-expanded={showVersions}
                      aria-label={`Choose a version of ${project.name}`}
                    >
                      <h2 className="min-w-0 truncate text-xl font-semibold leading-8 text-foreground underline decoration-accent/55 decoration-1 underline-offset-4 md:text-2xl">
                        {project.name}
                      </h2>
                      <svg className={`h-4 w-4 shrink-0 text-muted-foreground/70 transition ${showVersions ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
                      </svg>
                      <span className="shrink-0 rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent/80">
                        {uploads.length + 1}
                      </span>
                    </button>
                  ) : (
                    <h2 className="min-w-0 truncate text-xl font-semibold leading-8 text-foreground md:text-2xl">
                      {project.name}
                    </h2>
                  )}
                  {file.projectId ? (
                    <span className="hidden min-w-0 truncate text-xs font-light text-muted-foreground/65 md:inline" title={selectedVersionMetadata}>
                      {selectedVersionMetadata}
                    </span>
                  ) : file.year ? (
                    <span
                      className="shrink-0 text-xs font-light text-muted-foreground/65"
                      title={`Recorded ${formatCreatedDate(file)}`}
                    >
                      {file.year}
                    </span>
                  ) : null}
                  {!file.projectId && file.originalName && file.originalName !== project.name && (
                    <span className="hidden min-w-0 truncate text-sm font-light text-muted-foreground/70 sm:block">
                      ({file.originalName})
                    </span>
                  )}
                  {currentUser.isAdmin && (
                    <button
                      type="button"
                      onClick={() => {
                        setRenameDraft(project.name);
                        setIsRenaming(true);
                      }}
                      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border/60 text-muted-foreground opacity-60 transition hover:border-border hover:text-foreground hover:opacity-100"
                      title="Rename song project"
                      aria-label={`Rename ${project.name}`}
                    >
                      <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m16.9 4.7 2.4 2.4M4 20h4.8L20 8.8a1.7 1.7 0 0 0 0-2.4L17.6 4a1.7 1.7 0 0 0-2.4 0L4 15.2V20z" />
                      </svg>
                    </button>
                  )}
                  {showVersions && (
                    <div className="absolute left-0 top-[calc(100%+0.35rem)] z-[200] w-[min(28rem,calc(100vw-2rem))] overflow-hidden rounded-md border border-border/75 bg-[#0d1419]/98 py-1 shadow-2xl shadow-black/50 backdrop-blur">
                      <button
                        type="button"
                        onClick={() => {
                          selectFileVersion(project);
                          setShowVersions(false);
                        }}
                        className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition hover:bg-muted/45 ${file.id === project.id ? 'bg-accent/10' : ''}`}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-foreground">Original recording</span>
                          <span className="block truncate text-xs text-muted-foreground">{project.originalName || project.name}</span>
                        </span>
                        <span className="shrink-0 text-[11px] text-muted-foreground/70">{project.year || ''}</span>
                      </button>
                      {uploads.map(upload => {
                        const uploadDate = formatShortDate(upload.uploadedAt);
                        const isLinkedVariation = upload.variationType === 'linked';
                        return (
                          <button
                            key={upload.id}
                            type="button"
                            onClick={() => {
                              selectFileVersion(upload);
                              setShowVersions(false);
                            }}
                            className={`flex w-full items-center justify-between gap-3 border-t border-border/45 px-3 py-2 text-left transition hover:bg-muted/45 ${file.id === upload.id ? 'bg-accent/10' : ''}`}
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-medium text-foreground">
                                {isLinkedVariation ? upload.name : upload.originalName || 'Uploaded version'}
                              </span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {isLinkedVariation
                                  ? `Linked variation${upload.year ? ` · recorded ${upload.year}` : ''}`
                                  : `Uploaded by ${(upload.uploadedBy ? accountNamesById.get(upload.uploadedBy) : '') || upload.uploadedByName || upload.uploadedBy || 'Unknown'}`}
                              </span>
                            </span>
                            <span className={`shrink-0 text-[11px] ${isLinkedVariation ? 'rounded-full bg-accent/10 px-1.5 py-0.5 text-accent/80' : 'text-muted-foreground/70'}`}>
                              {isLinkedVariation ? 'Linked' : uploadDate}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="hidden absolute right-52 top-0 z-30 overflow-hidden rounded border border-border/70 bg-[#0f171c]/80 opacity-70 shadow-sm backdrop-blur transition hover:opacity-90">
            <button
              type="button"
              onClick={handleVolumeBoostClick}
              className={`min-h-8 px-3 py-1 text-xs font-medium leading-none transition ${
                isVolumeBoosted
                  ? 'bg-accent/15 text-accent'
                  : volumeBoostConfirming
                    ? 'bg-accent/10 text-accent'
                    : 'text-muted-foreground hover:text-foreground'
              }`}
              title={`Boost this song by ${VOL_BOOST_DB} dB`}
            >
              {isVolumeBoosted ? `+${VOL_BOOST_DB} dB` : volumeBoostConfirming ? 'Confirm' : 'Vol Boost'}
            </button>
          </div>
          <div className="absolute right-52 top-0 z-30 hidden overflow-hidden rounded border border-border/70 bg-[#0f171c]/80 opacity-70 shadow-sm backdrop-blur transition hover:opacity-90 md:inline-flex">
            <button
              type="button"
              onClick={refreshWaveform}
              disabled={waveformRefreshing}
              className="inline-flex h-8 w-9 items-center justify-center text-muted-foreground transition hover:text-foreground disabled:opacity-35"
              title="Refresh waveform"
              aria-label={`Refresh waveform for ${file.name}`}
            >
              <svg className={`h-3.5 w-3.5 ${waveformRefreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 11a8.1 8.1 0 0 0-15.5-2M4 5v4h4m-4 4a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" />
              </svg>
            </button>
            <a
              href={`/api/files/${encodeURIComponent(file.id)}/audio?download=1`}
              download={file.originalName || file.name}
              className="inline-flex h-8 w-9 items-center justify-center border-l border-border/70 text-muted-foreground transition hover:text-foreground"
              title="Download audio"
              aria-label={`Download ${file.name}`}
            >
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v11m0 0 4-4m-4 4-4-4M5 19h14" />
              </svg>
            </a>
            {currentUser.isAdmin && (
              <button
                type="button"
                onClick={() => {
                  setShowLinkSearch(prev => !prev);
                  setShowSendPanel(false);
                  setLinkSearchQuery('');
                  setLinkError('');
                }}
                className={`inline-flex h-8 w-9 items-center justify-center border-l border-border/70 transition ${showLinkSearch ? 'bg-accent/10 text-accent' : 'text-muted-foreground hover:text-foreground'}`}
                title={`Link ${project.name} to another song`}
                aria-label={`Link ${project.name} to another song`}
                aria-expanded={showLinkSearch}
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1m3.1 5.8a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20l1.1-1.1" />
                </svg>
              </button>
            )}
            {currentUser.isAdmin && (
              <button
                type="button"
                onClick={() => {
                  setShowSendPanel(prev => !prev);
                  setShowLinkSearch(false);
                  setSelectedRecipientId('');
                  setSendNote('');
                  setSendError('');
                  setSendSuccess('');
                }}
                className={`inline-flex h-8 w-9 items-center justify-center border-l border-border/70 transition ${showSendPanel ? 'bg-accent/10 text-accent' : 'text-muted-foreground hover:text-foreground'}`}
                title={`Send ${project.name} to a user`}
                aria-label={`Send ${project.name} to a user`}
                aria-expanded={showSendPanel}
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5h16v14H4zM4 7l8 6 8-6" />
                </svg>
              </button>
            )}
          </div>
          {currentUser.isAdmin && showLinkSearch && renderLinkSearchPanel(
            'right-52 top-10 hidden md:block',
            `link-song-desktop-${project.id}`,
          )}
          {currentUser.isAdmin && showSendPanel && renderSendPanel('right-52 top-10 hidden md:block')}

          <div className="relative mt-1 min-h-40 min-w-0 sm:min-h-36 md:-ml-[3.25rem] md:-mt-5 md:w-[calc(100%+3.25rem)] md:min-h-[118px]">
            <div className="hidden absolute right-0 top-0 z-10 overflow-hidden rounded border border-border/70 bg-[#0f171c]/80 opacity-70 shadow-sm backdrop-blur transition hover:opacity-90">
              <button
                type="button"
                onClick={handleVolumeBoostClick}
                className={`min-h-8 px-3 py-1 text-xs font-medium leading-none transition ${
                  isVolumeBoosted
                    ? 'bg-accent/15 text-accent'
                    : volumeBoostConfirming
                      ? 'bg-accent/10 text-accent'
                      : 'text-muted-foreground hover:text-foreground'
                }`}
                title={`Boost this song by ${VOL_BOOST_DB} dB`}
              >
                {isVolumeBoosted ? `+${VOL_BOOST_DB} dB` : volumeBoostConfirming ? 'Confirm' : 'Vol Boost'}
              </button>
            </div>
            <div className="absolute right-0 top-0 z-10 inline-flex overflow-hidden rounded border border-border/70 bg-[#0f171c]/80 opacity-70 shadow-sm backdrop-blur transition hover:opacity-90 md:hidden">
              <button
                type="button"
                onClick={refreshWaveform}
                disabled={waveformRefreshing}
                className="inline-flex h-8 w-9 items-center justify-center text-muted-foreground transition hover:text-foreground disabled:opacity-35"
                title="Refresh waveform"
                aria-label={`Refresh waveform for ${file.name}`}
              >
                <svg className={`h-3.5 w-3.5 ${waveformRefreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 11a8.1 8.1 0 0 0-15.5-2M4 5v4h4m-4 4a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" />
                </svg>
              </button>
              <a
                href={`/api/files/${encodeURIComponent(file.id)}/audio?download=1`}
                download={file.originalName || file.name}
                className="inline-flex h-8 w-9 items-center justify-center border-l border-border/70 text-muted-foreground transition hover:text-foreground"
                title="Download audio"
                aria-label={`Download ${file.name}`}
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v11m0 0 4-4m-4 4-4-4M5 19h14" />
                </svg>
              </a>
              {currentUser.isAdmin && (
                <button
                  type="button"
                  onClick={() => {
                    setShowLinkSearch(prev => !prev);
                    setShowSendPanel(false);
                    setLinkSearchQuery('');
                    setLinkError('');
                  }}
                  className={`inline-flex h-8 w-9 items-center justify-center border-l border-border/70 transition ${showLinkSearch ? 'bg-accent/10 text-accent' : 'text-muted-foreground hover:text-foreground'}`}
                  title={`Link ${project.name} to another song`}
                  aria-label={`Link ${project.name} to another song`}
                  aria-expanded={showLinkSearch}
                >
                  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1m3.1 5.8a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20l1.1-1.1" />
                  </svg>
                </button>
              )}
              {currentUser.isAdmin && (
                <button
                  type="button"
                  onClick={() => {
                    setShowSendPanel(prev => !prev);
                    setShowLinkSearch(false);
                    setSelectedRecipientId('');
                    setSendNote('');
                    setSendError('');
                    setSendSuccess('');
                  }}
                  className={`inline-flex h-8 w-9 items-center justify-center border-l border-border/70 transition ${showSendPanel ? 'bg-accent/10 text-accent' : 'text-muted-foreground hover:text-foreground'}`}
                  title={`Send ${project.name} to a user`}
                  aria-label={`Send ${project.name} to a user`}
                  aria-expanded={showSendPanel}
                >
                  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5h16v14H4zM4 7l8 6 8-6" />
                  </svg>
                </button>
              )}
            </div>
            {currentUser.isAdmin && showLinkSearch && renderLinkSearchPanel(
              'right-0 top-10 md:hidden',
              `link-song-mobile-${project.id}`,
            )}
            {currentUser.isAdmin && showSendPanel && renderSendPanel('right-0 top-10 md:hidden')}
            <div 
              ref={waveformRef} 
              className="min-h-40 w-full cursor-pointer pt-8 sm:min-h-36 md:min-h-[118px] md:pt-2"
            >
              {!shouldRenderWaveform && (
                <div className="flex h-32 w-full items-center justify-center text-xs text-muted-foreground/75 md:h-24">
                  Waveform loads on scroll
                </div>
              )}
            </div>
            {durationLabel && (
              <span className="pointer-events-none absolute bottom-10 right-0 z-30 rounded bg-[#0b0f14]/80 px-1.5 py-0.5 text-sm font-light text-muted-foreground/90 shadow-sm backdrop-blur md:bottom-8">
                {timeLabel}
              </span>
            )}
            {markerDuration > 0 && comments.some(comment => typeof comment.timestamp === 'number') && (
              <div className="pointer-events-none absolute inset-x-0 top-8 z-20 h-[calc(100%-2.25rem)] md:top-2 md:h-[calc(100%-0.75rem)]">
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
                    title={`${getCommentDisplayName(comment)}: ${comment.text}`}
                    aria-label={`Open comment from ${getCommentDisplayName(comment)}`}
                  >
                    <span className="absolute bottom-0 top-2 w-px rounded-full bg-accent/45" />
                    <span className="relative h-3.5 w-3.5 rounded-full border border-background/80 bg-accent/80 shadow-sm transition group-hover:bg-accent" />
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="relative z-20 mt-2 grid gap-3 md:-ml-[3.25rem] md:-mt-5 md:w-[calc(100%+3.25rem)] md:block">
            <div className="min-w-0 space-y-1.5 md:pb-1 md:pr-[20rem]">
              <div className="flex items-center gap-1.5">
                {currentUser.isAdmin ? (
                  <button
                    type="button"
                    onClick={() => setOpenTagPicker(prev => prev === 'instruments' ? null : 'instruments')}
                    className="group inline-flex h-6 w-8 shrink-0 items-center justify-center rounded text-muted-foreground/75 transition hover:bg-muted/35 hover:text-foreground"
                    aria-label={`Add instrument tag to ${file.name}`}
                    title="Add instrument tag"
                  >
                    <svg className="h-4 w-4 overflow-visible transition group-hover:hidden" viewBox="-18 -18 548 548" fill="currentColor" aria-hidden="true">
                      <path d="M502.7 39.02L473 9.37c-12.5-12.5-32.74-12.49-45.24 .0106l-46.24 46.37c-3.875 3.875-6.848 8.506-8.598 13.76l-12.19 36.51L284.5 182.3C272.4 173.5 259 166.5 244.4 163.1C211 155.4 177.4 162.3 154.5 185.1C145.3 194.5 138.3 206 134.3 218.6C128.3 237.1 111.1 251.3 92.14 253C68.52 255.4 46.39 264.5 29.52 281.5c-45.62 45.5-37.38 127.5 18.12 183c55.37 55.38 137.4 63.51 182.9 18c16.1-16.88 26.25-38.85 28.5-62.72c1.75-18.75 15.84-36.16 34.47-42.16c12.5-3.875 24.03-10.87 33.4-20.25c22.87-22.88 29.75-56.38 21.1-89.76c-3.375-14.63-10.39-27.99-19.14-40.11l76.25-76.26l36.53-12.17c5.125-1.75 9.894-4.715 13.77-8.59l46.36-46.29C515.2 71.72 515.2 51.52 502.7 39.02zM208 352c-26.5 0-48-21.5-48-48c0-26.5 21.5-48 48-48s47.1 21.5 47.1 48C256 330.5 234.5 352 208 352z" />
                    </svg>
                    <span className="hidden text-base leading-none group-hover:inline">{openTagPicker === 'instruments' ? '-' : '+'}</span>
                  </button>
                ) : (
                  <span className="inline-flex h-6 w-8 shrink-0 items-center justify-center text-muted-foreground/75" title="Instruments" aria-label="Instruments">
                    <svg className="h-4 w-4 overflow-visible" viewBox="-18 -18 548 548" fill="currentColor" aria-hidden="true">
                      <path d="M502.7 39.02L473 9.37c-12.5-12.5-32.74-12.49-45.24 .0106l-46.24 46.37c-3.875 3.875-6.848 8.506-8.598 13.76l-12.19 36.51L284.5 182.3C272.4 173.5 259 166.5 244.4 163.1C211 155.4 177.4 162.3 154.5 185.1C145.3 194.5 138.3 206 134.3 218.6C128.3 237.1 111.1 251.3 92.14 253C68.52 255.4 46.39 264.5 29.52 281.5c-45.62 45.5-37.38 127.5 18.12 183c55.37 55.38 137.4 63.51 182.9 18c16.1-16.88 26.25-38.85 28.5-62.72c1.75-18.75 15.84-36.16 34.47-42.16c12.5-3.875 24.03-10.87 33.4-20.25c22.87-22.88 29.75-56.38 21.1-89.76c-3.375-14.63-10.39-27.99-19.14-40.11l76.25-76.26l36.53-12.17c5.125-1.75 9.894-4.715 13.77-8.59l46.36-46.29C515.2 71.72 515.2 51.52 502.7 39.02zM208 352c-26.5 0-48-21.5-48-48c0-26.5 21.5-48 48-48s47.1 21.5 47.1 48C256 330.5 234.5 352 208 352z" />
                    </svg>
                  </span>
                )}
                <div
                  className="flex min-w-0 flex-1 cursor-grab touch-pan-x select-none items-center gap-1.5 overflow-x-auto active:cursor-grabbing [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                  onWheel={handleTagRowWheel}
                  onPointerDown={handleTagRowPointerDown}
                >
                  {instruments.length === 0 ? (
                    <span className="shrink-0 text-xs font-light text-muted-foreground/65">None</span>
                  ) : instruments.map(tag => (
                    <button
                      key={`instrument-${tag}`}
                      type="button"
                      className="pointer-events-none shrink-0 rounded border border-border/70 bg-muted/35 px-2 py-0.5 text-xs text-[#7fa6c9] shadow-inner shadow-black/10"
                    >
                      {displayTag(tag)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                {currentUser.isAdmin ? (
                  <button
                    type="button"
                    onClick={() => setOpenTagPicker(prev => prev === 'vibes' ? null : 'vibes')}
                    className="group inline-flex h-6 w-8 shrink-0 items-center justify-center rounded text-muted-foreground/75 transition hover:bg-muted/35 hover:text-foreground"
                    aria-label={`Add vibe tag to ${file.name}`}
                    title="Add vibe tag"
                  >
                    <svg className="h-4 w-4 transition group-hover:hidden" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M3 8c3.2-3 5.8 3 9 0s5.8 3 9 0" />
                      <path d="M3 14c3.2-3 5.8 3 9 0s5.8 3 9 0" />
                      <path d="M3 20c3.2-3 5.8 3 9 0s5.8 3 9 0" />
                    </svg>
                    <span className="hidden text-base leading-none group-hover:inline">{openTagPicker === 'vibes' ? '-' : '+'}</span>
                  </button>
                ) : (
                  <span className="inline-flex h-6 w-8 shrink-0 items-center justify-center text-muted-foreground/75" title="Vibe" aria-label="Vibe">
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M3 8c3.2-3 5.8 3 9 0s5.8 3 9 0" />
                      <path d="M3 14c3.2-3 5.8 3 9 0s5.8 3 9 0" />
                      <path d="M3 20c3.2-3 5.8 3 9 0s5.8 3 9 0" />
                    </svg>
                  </span>
                )}
                <div
                  className="flex min-w-0 flex-1 cursor-grab touch-pan-x select-none items-center gap-1.5 overflow-x-auto active:cursor-grabbing [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                  onWheel={handleTagRowWheel}
                  onPointerDown={handleTagRowPointerDown}
                >
                  {vibes.length === 0 ? (
                    <span className="shrink-0 text-xs font-light text-muted-foreground/65">None</span>
                  ) : vibes.map(tag => (
                    <button
                      key={`vibe-${tag}`}
                      type="button"
                      className="pointer-events-none shrink-0 rounded border border-border/70 bg-muted/35 px-2 py-0.5 text-xs text-[#7fa6c9] shadow-inner shadow-black/10"
                    >
                      {displayTag(tag)}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="pointer-events-none absolute bottom-0 right-[18rem] z-10 hidden h-14 w-20 bg-gradient-to-r from-transparent via-[#10181e]/85 to-[#10181e] md:block" />
            <div className="pointer-events-none absolute bottom-0 right-0 z-10 hidden h-14 w-[18rem] bg-[#10181e] md:block" />
            <div className="flex w-full max-w-full flex-wrap gap-3 md:absolute md:bottom-0 md:right-0 md:z-20 md:w-auto md:justify-end">
              <div className="grid w-full max-w-full grid-cols-6 overflow-hidden rounded border border-border/70 bg-[#0f171c] shadow-[0_0_16px_rgba(16,24,30,0.85)] sm:inline-flex sm:w-auto">
                <button
                  type="button"
                  onClick={toggleLike}
                  className={`col-span-1 row-start-2 inline-flex min-h-9 items-center justify-center border-r border-border/70 px-3 py-1.5 text-xs transition sm:min-h-0 sm:text-sm ${
                    file.liked
                      ? 'bg-red-400/10 text-red-300 hover:bg-red-400/15'
                      : 'text-muted-foreground hover:text-red-300'
                  }`}
                  aria-label={file.liked ? `Unlike ${file.name}` : `Like ${file.name}`}
                  title={file.liked ? 'Liked' : 'Like'}
                >
                  <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M12 20.25c-.32-.26-.78-.61-1.34-1.05C5.95 15.48 3.5 12.72 3.5 9.35 3.5 6.68 5.42 4.75 8 4.75c1.55 0 3.03.77 4 2.05.97-1.28 2.45-2.05 4-2.05 2.58 0 4.5 1.93 4.5 4.6 0 3.37-2.45 6.13-7.16 9.85-.56.44-1.02.79-1.34 1.05Z"
                      fill={file.liked ? 'currentColor' : 'none'}
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                {(currentUser.isAdmin || hasNotes) && (
                  <button
                    type="button"
                    onClick={() => setShowNotes(prev => !prev)}
                    className={`col-span-2 row-start-1 inline-flex min-h-9 min-w-0 items-center justify-center gap-1 whitespace-nowrap border-b border-r border-border/70 px-2 py-1.5 text-xs transition sm:min-h-0 sm:flex-none sm:gap-2 sm:border-b-0 sm:px-4 sm:text-sm ${
                      hasNotes
                        ? 'bg-accent/10 text-accent hover:bg-accent/15'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M8 6h8M8 10h8M8 14h5M5 3h14v18H5z" />
                    </svg>
                    Notes
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowComments(prev => !prev)}
                  className={`row-start-1 inline-flex min-h-9 min-w-0 items-center justify-center gap-1 whitespace-nowrap border-b border-r border-border/70 px-2 py-1.5 text-xs transition sm:min-h-0 sm:flex-none sm:gap-2 sm:border-b-0 sm:px-4 sm:text-sm ${
                    currentUser.isAdmin || hasNotes ? 'col-span-2' : 'col-span-3'
                  } ${
                    hasComments
                      ? 'bg-accent/10 text-accent hover:bg-accent/15'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v6A2.5 2.5 0 0 1 17.5 15H10l-4.5 4v-4A2.5 2.5 0 0 1 4 12.5z" />
                  </svg>
                  Comments {comments.length}
                </button>
                <button
                  type="button"
                  onClick={() => setShowCollections(prev => !prev)}
                  className={`row-start-1 inline-flex min-h-9 min-w-0 items-center justify-center gap-1 whitespace-nowrap border-b border-border/70 px-2 py-1.5 text-xs transition sm:min-h-0 sm:flex-none sm:gap-2 sm:border-b-0 sm:border-r sm:px-4 sm:text-sm ${
                    currentUser.isAdmin || hasNotes ? 'col-span-2' : 'col-span-3'
                  } ${
                    hasCollections
                      ? 'bg-accent/10 text-accent hover:bg-accent/15'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M3.5 7.5h6l2 2h9v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
                  </svg>
                  Collections
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowUpload(prev => !prev);
                    setUploadError('');
                  }}
                  className={`col-span-5 row-start-2 inline-flex min-h-9 w-full items-center justify-center gap-2 px-4 py-2 text-sm transition sm:min-h-0 sm:w-auto sm:py-1.5 ${
                    showUpload
                      ? 'bg-accent/10 text-accent hover:bg-accent/15'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  aria-expanded={showUpload}
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v5h14v-5" />
                  </svg>
                  Upload
                </button>
              </div>
              {file.stems && (
                <a
                  href={`/api/files/${encodeURIComponent(file.id)}/stems`}
                  download={file.stems.name}
                  className="inline-flex items-center gap-2 rounded border border-border/70 bg-background/35 px-4 py-1.5 text-sm text-muted-foreground transition hover:text-foreground"
                  title={file.stems.name}
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M12 3v11m0 0 4-4m-4 4-4-4M5 19h14" />
                  </svg>
                  Stems
                </a>
              )}
            </div>
          </div>

          {currentUser.isAdmin && openTagPicker === 'instruments' && (
            <div className="mt-2 flex flex-wrap gap-2 rounded border border-border/70 bg-background/60 p-2">
              {instrumentChoices.length > 0 ? instrumentChoices.map(tag => {
                const selected = instruments.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => toggleTag('instruments', tag)}
                    className={`rounded border px-2 py-1 text-xs transition ${
                      selected
                        ? 'border-accent/40 bg-accent/10 text-[#7fa6c9]'
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
          {currentUser.isAdmin && openTagPicker === 'vibes' && (
            <div className="mt-2 flex flex-wrap gap-2 rounded border border-border/70 bg-background/60 p-2">
              {vibeChoices.length > 0 ? vibeChoices.map(tag => {
                const selected = vibes.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => toggleTag('vibes', tag)}
                    className={`rounded border px-2 py-1 text-xs transition ${
                      selected
                        ? 'border-accent/40 bg-accent/10 text-[#7fa6c9]'
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

          <div className="mt-3 grid grid-cols-[4.75rem_auto] items-center gap-x-3 gap-y-1 rounded border border-border/35 bg-background/45 p-2 md:hidden">
            <span className="text-xs font-light text-muted-foreground">{adminName}&apos;s</span>
            <div className="flex items-center">
              {[1, 2, 3, 4, 5].map((star) => (
                currentUser.isAdmin ? (
                  <button
                    key={star}
                    type="button"
                    onClick={() => handleUserRatingChange(star, 'adam')}
                    onMouseEnter={() => setHoveredAdamRating(star)}
                    onMouseLeave={() => setHoveredAdamRating(0)}
                    className={`inline-flex h-8 w-7 items-center justify-center ${star <= displayedAdamRating ? adamRatingColorClass : emptyRatingColorClass}`}
                    aria-label={`Set ${adminName}'s rating to ${star} stars`}
                    title={`Set ${adminName}'s rating to ${star}`}
                  >
                    <StarIcon filled={star <= displayedAdamRating} />
                  </button>
                ) : (
                  <span
                    key={star}
                    className={`inline-flex h-8 w-7 items-center justify-center ${star <= adamRating ? adamRatingColorClass : emptyRatingColorClass}`}
                  >
                    <StarIcon filled={star <= adamRating} />
                  </span>
                )
              ))}
            </div>
            {currentUser.isAdmin ? (
              otherUserRatings.map(({ user, rating }) => (
                <Fragment key={user.id}>
                  <span className="truncate text-xs font-light text-muted-foreground" title={user.name}>{user.name}</span>
                  <div className="flex items-center">
                    {[1, 2, 3, 4, 5].map((star) => (
                      <span
                        key={star}
                        className={`inline-flex h-8 w-7 items-center justify-center ${star <= rating ? userRatingColorClass : emptyRatingColorClass}`}
                      >
                        <StarIcon filled={star <= rating} />
                      </span>
                    ))}
                  </div>
                </Fragment>
              ))
            ) : (
              <>
                <span className="text-xs font-light text-muted-foreground">Your&apos;s</span>
                <div className="flex items-center">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <button
                      key={star}
                      type="button"
                      onClick={() => handleUserRatingChange(star)}
                      onMouseEnter={() => setHoveredUserRating(star)}
                      onMouseLeave={() => setHoveredUserRating(0)}
                      className={`inline-flex h-8 w-7 items-center justify-center ${star <= displayedUserRating ? userRatingColorClass : emptyRatingColorClass}`}
                    >
                      <StarIcon filled={star <= displayedUserRating} />
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="pointer-events-auto absolute right-4 top-3 z-40 hidden max-w-[11.5rem] rounded bg-[#0b0f14]/30 px-2 py-1.5 shadow-[0_0_12px_rgba(11,15,20,0.28)] backdrop-blur-[1px] md:grid md:grid-cols-[3.7rem_auto] md:items-center md:gap-x-2 md:gap-y-1">
          <span className="text-xs font-light text-muted-foreground">{adminName}&apos;s</span>
          <div className="flex items-center">
            {[1, 2, 3, 4, 5].map((star) => (
              currentUser.isAdmin ? (
                <button
                  key={star}
                  type="button"
                  onClick={() => handleUserRatingChange(star, 'adam')}
                  onMouseEnter={() => setHoveredAdamRating(star)}
                  onMouseLeave={() => setHoveredAdamRating(0)}
                  className={`inline-flex h-6 w-5 items-center justify-center ${star <= displayedAdamRating ? adamRatingColorClass : emptyRatingColorClass}`}
                  aria-label={`Set ${adminName}'s rating to ${star} stars`}
                  title={`Set ${adminName}'s rating to ${star}`}
                >
                  <StarIcon filled={star <= displayedAdamRating} />
                </button>
              ) : (
                <span
                  key={star}
                  className={`inline-flex h-6 w-5 items-center justify-center ${star <= adamRating ? adamRatingColorClass : emptyRatingColorClass}`}
                >
                  <StarIcon filled={star <= adamRating} />
                </span>
              )
            ))}
          </div>
          {currentUser.isAdmin ? (
            otherUserRatings.map(({ user, rating }) => (
              <Fragment key={user.id}>
                <span className="truncate text-xs font-light text-muted-foreground" title={user.name}>{user.name}</span>
                <div className="flex items-center">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <span
                      key={star}
                      className={`inline-flex h-6 w-5 items-center justify-center ${star <= rating ? userRatingColorClass : emptyRatingColorClass}`}
                    >
                      <StarIcon filled={star <= rating} />
                    </span>
                  ))}
                </div>
              </Fragment>
            ))
          ) : (
            <>
              <span className="text-xs font-light text-muted-foreground">Your&apos;s</span>
              <div className="flex items-center">
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    type="button"
                    onClick={() => handleUserRatingChange(star)}
                    onMouseEnter={() => setHoveredUserRating(star)}
                    onMouseLeave={() => setHoveredUserRating(0)}
                    className={`inline-flex h-6 w-5 items-center justify-center ${star <= displayedUserRating ? userRatingColorClass : emptyRatingColorClass}`}
                  >
                    <StarIcon filled={star <= displayedUserRating} />
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {(showNotes || showComments || showCollections || showUpload) && (
        <div className="mt-3 space-y-3">
          {showNotes && (
            <div>
              {currentUser.isAdmin ? (
                <textarea
                  value={noteText}
                  onChange={(event) => setNoteText(event.target.value)}
                  onBlur={saveNotes}
                  placeholder="Add notes..."
                  className="min-h-24 w-full resize-y rounded-md border border-border/65 bg-background/65 p-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-accent"
                />
              ) : (
                <div className="min-h-16 w-full whitespace-pre-wrap rounded-md border border-border/65 bg-background/55 p-3 text-sm text-muted-foreground">
                  {noteText}
                </div>
              )}
            </div>
          )}
          {showComments && (
            <div className="overflow-hidden rounded-md bg-background/40">
              <div>
                {comments.length > 0 ? comments.map(comment => (
                  <div
                    key={comment.id}
                    className={`border-b border-border/45 p-3 text-sm transition last:border-b-0 ${
                      highlightedCommentId === comment.id
                        ? 'bg-accent/10'
                        : 'bg-transparent'
                    }`}
                  >
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground" title={formatCommentDate(comment.createdAt)}>{getCommentDisplayName(comment)}</span>
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
                  <p className="p-3 text-sm text-muted-foreground">No comments yet</p>
                )}
              </div>
              <div className="border-t border-border/45 bg-background/55 p-3">
                <textarea
                  value={newComment}
                  onChange={(event) => setNewComment(event.target.value)}
                  placeholder="Add a comment..."
                  className="min-h-20 w-full resize-y border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                />
                <div className="mt-2 flex flex-wrap items-center gap-3">
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
                      className="min-h-8 w-28 rounded border border-border/65 bg-background/65 px-2 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-accent sm:w-24 sm:text-xs"
                    />
                  )}
                  <button
                    type="button"
                    onClick={addComment}
                    disabled={!newComment.trim()}
                    className="ml-auto rounded bg-accent px-3 py-2 text-xs text-accent-foreground transition hover:bg-accent/90 disabled:opacity-50"
                  >
                    Add Comment
                  </button>
                </div>
              </div>
            </div>
          )}
          {showCollections && (
            <div className="rounded-md border border-border/65 bg-background/35 p-3">
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
                          ? 'border-accent/40 bg-accent/10 text-[#7fa6c9]'
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
                    ? 'border-accent/40 bg-accent/10 text-[#7fa6c9]'
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
          {showUpload && (
            <div className="rounded-md border border-accent/25 bg-background/45 p-3 sm:p-4">
              <div className="mb-3">
                <p className="text-sm font-medium text-foreground">Upload a new version</p>
                <p className="mt-0.5 text-xs text-muted-foreground">It will stay attached to {project.name} with its own notes and comments.</p>
                <p className="mt-1 text-xs font-medium text-accent/85">MP3, WAV, M4A, AAC, FLAC, OGG, or AIFF · 30 MB limit</p>
              </div>
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto] md:items-end">
                <label className="block min-w-0">
                  <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Audio file</span>
                  <input
                    ref={uploadInputRef}
                    type="file"
                    accept={VERSION_AUDIO_ACCEPT}
                    onChange={(event) => {
                      const nextFile = event.target.files?.[0] || null;
                      const hasInvalidType = Boolean(nextFile && !isCommonVersionAudioFile(nextFile));
                      setUploadFile(hasInvalidType ? null : nextFile);
                      setUploadError(
                        hasInvalidType
                          ? 'Use an MP3, WAV, M4A, AAC, FLAC, OGG, or AIFF audio file'
                          : nextFile && nextFile.size > MAX_VERSION_UPLOAD_BYTES
                            ? 'Audio uploads are limited to 30 MB'
                            : ''
                      );
                    }}
                    className="block w-full min-w-0 rounded border border-border/65 bg-background/65 text-sm text-muted-foreground file:mr-3 file:border-0 file:border-r file:border-border/65 file:bg-muted/40 file:px-3 file:py-2.5 file:text-xs file:font-medium file:text-foreground hover:file:bg-muted/60"
                  />
                </label>
                <label className="block min-w-0">
                  <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Notes</span>
                  <textarea
                    value={uploadNotes}
                    onChange={(event) => setUploadNotes(event.target.value)}
                    maxLength={10000}
                    placeholder="What changed in this version?"
                    className="min-h-10 w-full resize-y rounded border border-border/65 bg-background/65 px-3 py-2 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-accent"
                  />
                </label>
                <button
                  type="button"
                  onClick={uploadVersion}
                  disabled={!uploadFile || uploadFile.size > MAX_VERSION_UPLOAD_BYTES || isUploading}
                  className="min-h-10 rounded bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {isUploading ? 'Uploading…' : 'Upload Version'}
                </button>
              </div>
              {uploadError && (
                <p className="mt-2 text-xs text-red-300" role="alert">{uploadError}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export default function Home() {
  const [files, setFiles] = useState<AudioFile[]>([]);
  const [currentUser, setCurrentUser] = useState<ArchiveUser | null>(null);
  const [accountUsers, setAccountUsers] = useState<ArchiveUser[]>([]);
  const [archiveName, setArchiveName] = useState('the archive');
  const [selectedInstruments, setSelectedInstruments] = useState<string[]>([]);
  const [selectedVibes, setSelectedVibes] = useState<string[]>([]);
  const [selectedFinishes, setSelectedFinishes] = useState<string[]>([]);
  const [selectedCollections, setSelectedCollections] = useState<string[]>([]);
  const [selectedInteractionUsers, setSelectedInteractionUsers] = useState<string[]>([]);
  const [selectedYears, setSelectedYears] = useState<number[]>([]);
  const [selectedAdamRatings, setSelectedAdamRatings] = useState<number[]>([]);
  const [excludedInstruments, setExcludedInstruments] = useState<string[]>([]);
  const [excludedVibes, setExcludedVibes] = useState<string[]>([]);
  const [excludedFinishes, setExcludedFinishes] = useState<string[]>([]);
  const [excludedCollections, setExcludedCollections] = useState<string[]>([]);
  const [excludedInteractionUsers, setExcludedInteractionUsers] = useState<string[]>([]);
  const [excludedYears, setExcludedYears] = useState<number[]>([]);
  const [excludedAdamRatings, setExcludedAdamRatings] = useState<number[]>([]);
  const [likedOnly, setLikedOnly] = useState(false);
  const [untaggedOnly, setUntaggedOnly] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [showInbox, setShowInbox] = useState(true);
  const [inboxMessages, setInboxMessages] = useState<InboxMessage[]>([]);
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchNotes, setSearchNotes] = useState(false);
  const [collapsedFilters, setCollapsedFilters] = useState({
    instruments: true,
    vibes: true,
    finish: true,
    collections: true,
    interactions: true,
    years: true,
    adamsRatings: true,
  });
  const [instrumentOptions, setInstrumentOptions] = useState<string[]>([]);
  const [vibeOptions, setVibeOptions] = useState<string[]>([]);
  const [newInstrument, setNewInstrument] = useState('');
  const [newVibe, setNewVibe] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('adamsRatingRandom');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [randomSortSeed, setRandomSortSeed] = useState(() => Math.random());
  const [randomTrackIds, setRandomTrackIds] = useState<string[] | null>(null);
  const [activeTrack, setActiveTrack] = useState<AudioFile | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [miniVolume, setMiniVolume] = useState(1);
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
  const miniVolumeRef = useRef(1);
  const lastMediaSessionPositionSyncRef = useRef(0);
  const playerRegistryRef = useRef<Map<string, PlayerRegistryEntry>>(new Map());
  const renderedFilesRef = useRef<AudioFile[]>([]);
  const pendingPlaybackTrackIdRef = useRef<string | null>(null);
  const adminName = accountUsers.find(user => user.id === 'adam')?.name || 'Admin';

  useEffect(() => {
    fetch('/api/session')
      .then(res => res.json())
      .then((data: { user: ArchiveUser | null; users: ArchiveUser[]; settings?: { archiveName?: string; defaultInstruments?: string[]; defaultVibes?: string[]; legacyDefaults?: boolean } }) => {
        setCurrentUser(data.user);
        setAccountUsers(data.users);
        setArchiveName(data.settings?.archiveName || 'the archive');
        setSelectedFinishes(data.settings?.legacyDefaults ? ['Tracked', 'Recorder'] : []);
        setInstrumentOptions(prev => Array.from(new Set([...prev, ...(data.settings?.defaultInstruments || [])])));
        setVibeOptions(prev => Array.from(new Set([...prev, ...(data.settings?.defaultVibes || [])])));
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

  useEffect(() => {
    const loadInbox = () => {
      fetch('/api/inbox')
        .then(res => res.ok ? res.json() : { inbox: [] })
        .then((data: { inbox?: InboxMessage[] }) => {
          setInboxMessages(Array.isArray(data.inbox) ? data.inbox : []);
        });
    };

    loadInbox();
    window.addEventListener('focus', loadInbox);
    const intervalId = window.setInterval(loadInbox, 60000);
    return () => {
      window.removeEventListener('focus', loadInbox);
      window.clearInterval(intervalId);
    };
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
    const interactionUserIds = getInteractionUserIds(file);
    const fileYear = file.year || 0;
    const adamRating = getAdamRating(file);
    const matchesSearch = normalizedSearch.length === 0
      || file.name.toLowerCase().includes(normalizedSearch)
      || (searchNotes && getNoteText(file).toLowerCase().includes(normalizedSearch));
    const matchesCollectionFilter = (
      (selectedCollections.length === 0 || fileCollections.some(collection => selectedCollections.includes(collection)))
      && !hasAny(fileCollections, excludedCollections)
    );

    if (selectedCollections.length > 0 || excludedCollections.length > 0) {
      return matchesCollectionFilter;
    }

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
      matchesCollectionFilter &&
      (selectedInteractionUsers.length === 0 || hasAny(interactionUserIds, selectedInteractionUsers)) &&
      !hasAny(interactionUserIds, excludedInteractionUsers) &&
      (selectedYears.length === 0 || selectedYears.includes(fileYear)) &&
      !excludedYears.includes(fileYear) &&
      (selectedAdamRatings.length === 0 || selectedAdamRatings.includes(adamRating)) &&
      !excludedAdamRatings.includes(adamRating)
    );
  }, [excludedAdamRatings, excludedCollections, excludedFinishes, excludedInstruments, excludedInteractionUsers, excludedVibes, excludedYears, likedOnly, searchNotes, searchQuery, selectedAdamRatings, selectedCollections, selectedFinishes, selectedInstruments, selectedInteractionUsers, selectedVibes, selectedYears, untaggedOnly]);

  const matchesFiltersExcept = useCallback((file: AudioFile, except: FilterCategory) => {
    const normalizedSearch = searchQuery.trim().toLowerCase();
    const instruments = getTags(file, 'instruments', 'instrument');
    const vibes = getTags(file, 'vibes', 'vibe');
    const fileCollections = Array.isArray(file.collections) ? file.collections.filter(Boolean) : [];
    const interactionUserIds = getInteractionUserIds(file);
    const fileYear = file.year || 0;
    const adamRating = getAdamRating(file);
    const matchesSearch = normalizedSearch.length === 0
      || file.name.toLowerCase().includes(normalizedSearch)
      || (searchNotes && getNoteText(file).toLowerCase().includes(normalizedSearch));
    const matchesCollectionFilter = (
      (selectedCollections.length === 0 || fileCollections.some(collection => selectedCollections.includes(collection)))
      && !hasAny(fileCollections, excludedCollections)
    );

    if (except !== 'collections' && (selectedCollections.length > 0 || excludedCollections.length > 0)) {
      return matchesCollectionFilter;
    }

    return (
      matchesSearch &&
      (!likedOnly || Boolean(file.liked)) &&
      (!untaggedOnly || isUntaggedFile(file)) &&
      (except === 'instruments' || ((selectedInstruments.length === 0 || hasAny(instruments, selectedInstruments)) && !hasAny(instruments, excludedInstruments))) &&
      (except === 'vibes' || ((selectedVibes.length === 0 || hasAny(vibes, selectedVibes)) && !hasAny(vibes, excludedVibes))) &&
      (except === 'finish' || ((selectedFinishes.length === 0 || (file.finish ? selectedFinishes.includes(file.finish) : false)) && (!file.finish || !excludedFinishes.includes(file.finish)))) &&
      (except === 'collections' || matchesCollectionFilter) &&
      (except === 'interactions' || ((selectedInteractionUsers.length === 0 || hasAny(interactionUserIds, selectedInteractionUsers)) && !hasAny(interactionUserIds, excludedInteractionUsers))) &&
      (except === 'years' || ((selectedYears.length === 0 || selectedYears.includes(fileYear)) && !excludedYears.includes(fileYear))) &&
      (except === 'adamsRatings' || ((selectedAdamRatings.length === 0 || selectedAdamRatings.includes(adamRating)) && !excludedAdamRatings.includes(adamRating)))
    );
  }, [excludedAdamRatings, excludedCollections, excludedFinishes, excludedInstruments, excludedInteractionUsers, excludedVibes, excludedYears, likedOnly, searchNotes, searchQuery, selectedAdamRatings, selectedCollections, selectedFinishes, selectedInstruments, selectedInteractionUsers, selectedVibes, selectedYears, untaggedOnly]);

  const matchesRandomFilters = useCallback((file: AudioFile) => {
    const normalizedSearch = searchQuery.trim().toLowerCase();
    const instruments = getTags(file, 'instruments', 'instrument');
    const vibes = getTags(file, 'vibes', 'vibe');
    const fileCollections = Array.isArray(file.collections) ? file.collections.filter(Boolean) : [];
    const interactionUserIds = getInteractionUserIds(file);
    const fileYear = file.year || 0;
    const adamRating = getAdamRating(file);
    const matchesSearch = normalizedSearch.length === 0
      || file.name.toLowerCase().includes(normalizedSearch)
      || (searchNotes && getNoteText(file).toLowerCase().includes(normalizedSearch));
    const matchesCollectionFilter = (
      (selectedCollections.length === 0 || fileCollections.some(collection => selectedCollections.includes(collection)))
      && !hasAny(fileCollections, excludedCollections)
    );

    if (selectedCollections.length > 0 || excludedCollections.length > 0) {
      return matchesCollectionFilter;
    }

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
      matchesCollectionFilter &&
      (selectedInteractionUsers.length === 0 || hasAny(interactionUserIds, selectedInteractionUsers)) &&
      !hasAny(interactionUserIds, excludedInteractionUsers) &&
      (selectedYears.length === 0 || selectedYears.includes(fileYear)) &&
      !excludedYears.includes(fileYear) &&
      (selectedAdamRatings.length === 0 || selectedAdamRatings.includes(adamRating)) &&
      !excludedAdamRatings.includes(adamRating)
    );
  }, [excludedAdamRatings, excludedCollections, excludedFinishes, excludedInstruments, excludedInteractionUsers, excludedVibes, excludedYears, likedOnly, searchNotes, searchQuery, selectedAdamRatings, selectedCollections, selectedFinishes, selectedInstruments, selectedInteractionUsers, selectedVibes, selectedYears, untaggedOnly]);

  const sortedFilteredFiles = useMemo(() => {
    return files.filter(matchesFilters).sort(compareFiles);
  }, [compareFiles, files, matchesFilters]);

  const randomCandidates = useMemo(() => {
    return files.filter(matchesRandomFilters);
  }, [files, matchesRandomFilters]);

  const activityFileIds = useMemo(() => new Set(
    files
      .filter(file => {
        const hasCommentActivity = (Array.isArray(file.comments) ? file.comments : [])
          .some(comment => comment.userId && comment.userId !== 'adam' && comment.text);
        const hasRatingActivity = Object.entries(file.ratings || {})
          .some(([userId, rating]) => userId !== 'adam' && (rating || 0) > 0);
        return hasCommentActivity || hasRatingActivity;
      })
      .map(file => file.id)
  ), [files]);

  const filteredFiles = useMemo(() => {
    if (showActivity) {
      return files.filter(file => activityFileIds.has(file.id)).sort(compareFiles);
    }

    if (!randomTrackIds) return sortedFilteredFiles;

    const fileById = new Map(files.map(file => [file.id, file]));
    return randomTrackIds.flatMap(id => {
      const file = fileById.get(id);
      return file && matchesRandomFilters(file) ? [file] : [];
    });
  }, [activityFileIds, compareFiles, files, matchesRandomFilters, randomTrackIds, showActivity, sortedFilteredFiles]);

  const filterKey = useMemo(() => JSON.stringify({
    searchNotes,
    searchQuery,
    selectedCollections,
    selectedFinishes,
    selectedInstruments,
    selectedInteractionUsers,
    selectedVibes,
    selectedYears,
    selectedAdamRatings,
    excludedCollections,
    excludedFinishes,
    excludedInstruments,
    excludedInteractionUsers,
    excludedVibes,
    excludedYears,
    excludedAdamRatings,
    likedOnly,
    untaggedOnly,
    randomTrackIds,
    randomSortSeed,
    showActivity,
    sortBy,
    sortDirection,
  }), [excludedAdamRatings, excludedCollections, excludedFinishes, excludedInstruments, excludedInteractionUsers, excludedVibes, excludedYears, likedOnly, randomSortSeed, randomTrackIds, searchNotes, searchQuery, selectedAdamRatings, selectedCollections, selectedFinishes, selectedInstruments, selectedInteractionUsers, selectedVibes, selectedYears, showActivity, sortBy, sortDirection, untaggedOnly]);

  const renderLimit = renderWindow.key === filterKey ? renderWindow.limit : INITIAL_RENDER_LIMIT;

  const visibleFileIds = useMemo(() => new Set(filteredFiles.map(file => file.id)), [filteredFiles]);

  const renderedFiles = useMemo(() => {
    const additionalFiles: AudioFile[] = [];
    const additionalIds = new Set<string>();
    const addFile = (file: AudioFile | undefined) => {
      if (!file || visibleFileIds.has(file.id) || additionalIds.has(file.id)) return;
      additionalIds.add(file.id);
      additionalFiles.push(file);
    };

    if (activeTrack) {
      addFile(files.find(file => file.id === getProjectId(activeTrack)) || activeTrack);
    }
    if (targetTrackId) {
      addFile(files.find(file => file.id === targetTrackId));
    }

    return additionalFiles.length > 0
      ? [...filteredFiles, ...additionalFiles].sort(compareFiles)
      : filteredFiles;
  }, [activeTrack, compareFiles, files, filteredFiles, targetTrackId, visibleFileIds]);

  const unreadInboxCount = useMemo(
    () => inboxMessages.filter(message => !message.readAt).length,
    [inboxMessages]
  );

  const targetTrackIndex = targetTrackId ? renderedFiles.findIndex(file => file.id === targetTrackId) : -1;
  const effectiveRenderLimit = targetTrackIndex >= renderLimit
    ? Math.min(renderedFiles.length, targetTrackIndex + RENDER_BATCH_SIZE)
    : renderLimit;

  const activeTrackIndex = activeTrack ? renderedFiles.findIndex(file => file.id === getProjectId(activeTrack)) : -1;

  const playbackPreloadFileIds = useMemo(() => {
    const ids = new Set<string>();
    if (activeTrackIndex < 0) return ids;

    for (const index of [activeTrackIndex - 1, activeTrackIndex, activeTrackIndex + 1]) {
      const file = renderedFiles[index];
      if (file) ids.add(file.id);
    }

    return ids;
  }, [activeTrackIndex, renderedFiles]);

  const displayedFiles = useMemo(() => {
    const displayIds = new Set(renderedFiles.slice(0, effectiveRenderLimit).map(file => file.id));
    playbackPreloadFileIds.forEach(id => displayIds.add(id));
    return renderedFiles.filter(file => displayIds.has(file.id));
  }, [effectiveRenderLimit, playbackPreloadFileIds, renderedFiles]);

  const hasMoreFiles = effectiveRenderLimit < renderedFiles.length;

  const yearOptions = useMemo(() => (
    Array.from(new Set(files.map(f => f.year || 0))).sort((a, b) => b - a)
  ), [files]);
  const adamRatingOptions = [5, 4, 3, 2, 1, 0];
  const finishOptions = useMemo(() => (
    Array.from(new Set([...FINISH_OPTIONS, ...files.map(file => file.finish || '').filter(Boolean)]))
  ), [files]);
  const collectionOptions = useMemo(() => (
    Array.from(new Set(files.flatMap(file => Array.isArray(file.collections) ? file.collections.filter(Boolean) : []))).sort((a, b) => a.localeCompare(b))
  ), [files]);
  const interactionUsers = useMemo(() => (
    accountUsers
      .filter(user => user.id !== currentUser?.id)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  ), [accountUsers, currentUser?.id]);

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
            userName: userNameById.get(comment.userId) || comment.userName || comment.userId,
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
      interactions: new Map<string, number>(),
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
      new Set(Array.isArray(file.collections) ? file.collections.filter(Boolean) : [])
        .forEach(collection => increment(counts.collections, collection));
      if (matchesFiltersExcept(file, 'interactions')) {
        getInteractionUserIds(file).forEach(userId => increment(counts.interactions, userId));
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

      const duration = hasCachedWaveform(activeTrack) ? activeTrack.waveformDuration || ws.getDuration() : ws.getDuration();
      const currentTime = ws.getCurrentTime();
      const hidden = document.hidden;
      if (!hidden) {
        setProgress(duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0);
        setIsPlaying(ws.isPlaying());
      }

      const now = performance.now();
      if (
        'mediaSession' in navigator &&
        duration > 0 &&
        Number.isFinite(duration) &&
        (!hidden || now - lastMediaSessionPositionSyncRef.current > 2000)
      ) {
        try {
          lastMediaSessionPositionSyncRef.current = now;
          navigator.mediaSession.setPositionState({
            duration,
            playbackRate: 1,
            position: Math.min(duration, Math.max(0, currentTime)),
          });
        } catch {
          // Android media controls can reject position state while metadata is changing.
        }
      }
    }, 200);

    return () => clearInterval(interval);
  }, [activeTrack]);

  useEffect(() => {
    endModeRef.current = endMode;
  }, [endMode]);

  useEffect(() => {
    miniVolumeRef.current = miniVolume;
  }, [miniVolume]);

  useEffect(() => {
    renderedFilesRef.current = renderedFiles;
  }, [renderedFiles]);

  const playRegisteredPlayer = useCallback((player: PlayerRegistryEntry, shouldScroll = true) => {
    player.wavesurfer.setVolume(miniVolumeRef.current);
    void player.wavesurfer.play();
    if (shouldScroll && !document.hidden) {
      player.cardElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, []);

  const handleCardReady = useCallback((file: AudioFile, cardElement: HTMLDivElement, wavesurfer: WaveSurfer) => {
    const player = { cardElement, wavesurfer };
    playerRegistryRef.current.set(file.id, player);
    playerRegistryRef.current.set(getProjectId(file), player);
    if (pendingPlaybackTrackIdRef.current === file.id || pendingPlaybackTrackIdRef.current === getProjectId(file)) {
      pendingPlaybackTrackIdRef.current = null;
      playRegisteredPlayer(player);
    }
  }, [playRegisteredPlayer]);

  const handleCardPlay = useCallback((file: AudioFile, _cardElement: HTMLDivElement, wavesurfer: WaveSurfer) => {
    if (activeWaveSurferRef.current && activeWaveSurferRef.current !== wavesurfer) {
      activeWaveSurferRef.current.pause();
    }
    wavesurfer.setVolume(miniVolumeRef.current);
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
      const currentIndex = currentList.findIndex(track => track.id === getProjectId(file));
      const nextTrack = currentIndex >= 0 ? currentList[currentIndex + 1] : undefined;
      const nextPlayer = nextTrack ? playerRegistryRef.current.get(nextTrack.id) : undefined;

      if (nextPlayer) {
        playRegisteredPlayer(nextPlayer, false);
        return;
      }

      if (nextTrack) {
        pendingPlaybackTrackIdRef.current = nextTrack.id;
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
  }, [playRegisteredPlayer]);

  const clearActivePlayer = useCallback((file: AudioFile, wavesurfer: WaveSurfer) => {
    const registeredPlayer = playerRegistryRef.current.get(file.id);
    if (registeredPlayer?.wavesurfer === wavesurfer) {
      playerRegistryRef.current.delete(file.id);
    }
    const projectPlayer = playerRegistryRef.current.get(getProjectId(file));
    if (projectPlayer?.wavesurfer === wavesurfer) {
      playerRegistryRef.current.delete(getProjectId(file));
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
    seekWaveSurferToProgress(
      wavesurfer,
      progress,
      activeTrack && hasCachedWaveform(activeTrack) ? activeTrack.waveformDuration || 0 : 0
    );
    setProgress(progress * 100);
  }, [activeTrack]);

  const playRelativeTrack = useCallback((direction: 1 | -1) => {
    const currentTrackId = activeTrackIdRef.current;
    const currentProjectId = activeTrack?.projectId || currentTrackId;
    const currentList = renderedFilesRef.current;
    const currentIndex = currentProjectId ? currentList.findIndex(track => track.id === currentProjectId) : -1;
    const nextTrack = currentIndex >= 0 ? currentList[currentIndex + direction] : undefined;
    const nextPlayer = nextTrack ? playerRegistryRef.current.get(nextTrack.id) : undefined;

    if (!nextTrack) return;

    if (nextPlayer) {
      playRegisteredPlayer(nextPlayer);
      return;
    }

    pendingPlaybackTrackIdRef.current = nextTrack.id;
    setRenderWindow(prev => {
      const currentLimit = prev.key === filterKey ? prev.limit : INITIAL_RENDER_LIMIT;
      const nextLimit = Math.max(currentLimit, Math.min(currentList.length, currentIndex + direction + RENDER_BATCH_SIZE));
      return nextLimit === currentLimit ? prev : { key: filterKey, limit: nextLimit };
    });
  }, [activeTrack, filterKey, playRegisteredPlayer]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    if (!activeTrack) {
      navigator.mediaSession.playbackState = 'none';
      return;
    }

    if (typeof MediaMetadata !== 'undefined') {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: activeTrack.name,
        artist: archiveName,
        album: [
          ...getTags(activeTrack, 'instruments', 'instrument'),
          ...getTags(activeTrack, 'vibes', 'vibe'),
          activeTrack.finish || '',
        ].filter(Boolean).map(displayTag).join(' · ') || undefined,
      });
    }

    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    setMediaSessionAction('play', () => {
      void activeWaveSurferRef.current?.play();
    });
    setMediaSessionAction('pause', () => {
      activeWaveSurferRef.current?.pause();
    });
    setMediaSessionAction('nexttrack', () => playRelativeTrack(1));
    setMediaSessionAction('previoustrack', () => playRelativeTrack(-1));
    setMediaSessionAction('seekbackward', (details) => {
      const wavesurfer = activeWaveSurferRef.current;
      if (!wavesurfer) return;
      wavesurfer.setTime(Math.max(0, wavesurfer.getCurrentTime() - (details.seekOffset || 10)));
    });
    setMediaSessionAction('seekforward', (details) => {
      const wavesurfer = activeWaveSurferRef.current;
      if (!wavesurfer) return;
      const duration = activeTrack.waveformDuration || wavesurfer.getDuration();
      wavesurfer.setTime(Math.min(duration || Number.POSITIVE_INFINITY, wavesurfer.getCurrentTime() + (details.seekOffset || 10)));
    });
    setMediaSessionAction('seekto', (details) => {
      const wavesurfer = activeWaveSurferRef.current;
      if (!wavesurfer || details.seekTime === undefined) return;
      wavesurfer.setTime(details.seekTime);
    });
  }, [activeTrack, archiveName, isPlaying, playRelativeTrack]);

  const updateMiniVolume = useCallback((value: number) => {
    const nextVolume = Math.min(1, Math.max(0, value));
    miniVolumeRef.current = nextVolume;
    setMiniVolume(nextVolume);
    try {
      activeWaveSurferRef.current?.setVolume(nextVolume);
    } catch (error) {
      console.error('Failed to update mini-player volume', error);
    }
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
    setRandomTrackIds(null);
    setActivityTargetTrackId(file.id);
    setRenderWindow(prev => ({ ...prev, key: '', limit: INITIAL_RENDER_LIMIT }));
  }, []);

  const markInboxMessageRead = useCallback(async (message: InboxMessage) => {
    if (message.readAt) return;

    const readAt = new Date().toISOString();
    setInboxMessages(prev => prev.map(existing => (
      existing.id === message.id ? { ...existing, readAt } : existing
    )));

    const res = await fetch(`/api/inbox/${encodeURIComponent(message.id)}`, {
      method: 'PUT',
    });
    if (!res.ok) {
      setInboxMessages(prev => prev.map(existing => (
        existing.id === message.id ? { ...existing, readAt: undefined } : existing
      )));
    }
  }, []);

  const showInboxTrack = useCallback((message: InboxMessage) => {
    void markInboxMessageRead(message);
    const song = findProjectForFileId(files, message.songId);
    if (song) {
      showActivityTrack(song);
    }
  }, [files, markInboxMessageRead, showActivityTrack]);

  const randomIncludeVoiceMemos = (
    !excludedFinishes.includes('Voice Memo')
    && (selectedFinishes.length === 0 || selectedFinishes.includes('Voice Memo'))
  );

  const setVoiceMemosIncluded = useCallback((included: boolean) => {
    if (included) {
      setExcludedFinishes(prev => prev.filter(finish => finish !== 'Voice Memo'));
      setSelectedFinishes(prev => (
        prev.length === 0 || prev.includes('Voice Memo') ? prev : [...prev, 'Voice Memo']
      ));
      return;
    }

    setSelectedFinishes(prev => {
      const withoutVoiceMemos = prev.filter(finish => finish !== 'Voice Memo');
      return withoutVoiceMemos.length > 0
        ? withoutVoiceMemos
        : finishOptions.filter(finish => finish !== 'Voice Memo');
    });
    setExcludedFinishes(prev => prev.filter(finish => finish !== 'Voice Memo'));
  }, [finishOptions]);

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

  const interactionUserName = (userId: string) => (
    interactionUsers.find(user => user.id === userId)?.name || userId
  );

  const interactionFilterSummary = (selected: string[], excluded: string[]) => {
    const includedText = selected.map(interactionUserName).join(', ');
    const excludedText = excluded.map(interactionUserName).join(', ');
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

  const resetFiltersForCollection = () => {
    setSelectedInstruments([]);
    setExcludedInstruments([]);
    setSelectedVibes([]);
    setExcludedVibes([]);
    setSelectedFinishes([...FINISH_OPTIONS]);
    setExcludedFinishes([]);
    setSelectedYears([]);
    setExcludedYears([]);
    setSelectedAdamRatings([]);
    setExcludedAdamRatings([]);
    setSelectedInteractionUsers([]);
    setExcludedInteractionUsers([]);
    setLikedOnly(false);
    setUntaggedOnly(false);
    setSearchQuery('');
    setSearchNotes(false);
    setRandomTrackIds(null);
    setShowActivity(false);
    setActivityTargetTrackId(null);
  };

  const toggleCollectionFilterValue = (collection: string) => {
    resetFiltersForCollection();
    toggleFilterValue(collection, selectedCollections, setSelectedCollections, excludedCollections, setExcludedCollections);
  };

  const excludeCollectionFilterValue = (collection: string) => {
    resetFiltersForCollection();
    excludeFilterValue(collection, setSelectedCollections, setExcludedCollections);
  };

  const activeFilterCount =
    selectedInstruments.length + selectedVibes.length + selectedCollections.length + selectedInteractionUsers.length + selectedFinishes.length + selectedYears.length + selectedAdamRatings.length +
    excludedInstruments.length + excludedVibes.length + excludedCollections.length + excludedInteractionUsers.length + excludedFinishes.length + excludedYears.length + excludedAdamRatings.length +
    (likedOnly ? 1 : 0) + (untaggedOnly ? 1 : 0) + (searchQuery.trim() ? 1 : 0);
  const collapsedSummaryClass = "mt-0.5 block max-w-full truncate text-[11px] font-normal text-muted-foreground/70";
  const filterOptionClass = (mode: FilterMode) => {
    const modeClass = {
      include: 'border border-accent/55 bg-accent/85 text-accent-foreground shadow-sm shadow-accent/10',
      exclude: 'border border-red-400/40 bg-red-500/10 text-red-300 hover:bg-red-500/15',
      none: 'border border-border/40 bg-[#0b0f14] text-muted-foreground hover:border-accent/35 hover:text-foreground',
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
  const archiveNameParts = archiveName.trim().split(/\s+/);
  const archiveNameAccent = archiveNameParts.pop() || 'archive';
  const archiveNameLead = archiveNameParts.join(' ');

  return (
    <div className="archive-shell min-h-screen text-foreground">
      <header className="mx-auto grid h-auto max-w-[1800px] grid-cols-1 items-center gap-3 border-b border-border/40 px-3 py-3 sm:grid-cols-[1fr_auto_1fr] sm:px-4">
        <div className="hidden sm:block" />
        <div className="flex items-center justify-center gap-3">
          <svg className="h-8 w-16 text-accent drop-shadow-[0_0_10px_rgba(54,128,233,0.55)]" viewBox="0 0 120 44" aria-hidden="true">
            <path d="M4 22h11l5-9 6 18 7-28 8 38 8-26 6 11 5-16 5 30 8-36 7 27 6-14 5 5h24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" />
            <path d="M4 22h112" fill="none" stroke="rgba(255,255,255,0.8)" strokeLinecap="round" strokeWidth="2" />
          </svg>
          <div className="text-2xl font-light tracking-normal">
            {archiveNameLead && <span className="text-foreground">{archiveNameLead} </span>}
            <span className="text-accent">{archiveNameAccent}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-end">
          <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
            {currentUser && (
              <span className="col-span-2 inline-flex h-10 items-center justify-center rounded-full border border-border/65 bg-muted/35 px-3 text-center text-sm text-foreground sm:col-span-1">
                {currentUser.name.slice(0, 2).toUpperCase()}
              </span>
            )}
            {currentUser?.isAdmin && (
              <>
              <Link
                href="/manage"
                className="rounded border border-border/50 bg-muted/35 px-3 py-2 text-center text-sm text-muted-foreground transition hover:border-accent/40 hover:text-foreground"
              >
                Manage
              </Link>
              <Link
                href="/users"
                className="rounded border border-border/50 bg-muted/35 px-3 py-2 text-center text-sm text-muted-foreground transition hover:border-accent/40 hover:text-foreground"
              >
                Users
              </Link>
              <Link
                href="/upload"
                  className="rounded border border-accent/55 bg-accent/85 px-3 py-2 text-center text-sm text-accent-foreground shadow-sm shadow-accent/10 transition hover:bg-accent"
                >
                  Upload
                </Link>
              </>
            )}
            <button
              type="button"
              onClick={logout}
              className="rounded border border-border/50 bg-muted/35 px-3 py-2 text-sm text-muted-foreground transition hover:border-accent/40 hover:text-foreground"
            >
              Logout
            </button>
          </div>
        </div>
      </header>
      <div className="mx-auto flex max-w-[1800px] flex-col gap-4 p-3 pb-56 sm:p-4 sm:pb-36 md:flex-row">
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
        <div className={`${showMobileFilters ? 'block' : 'hidden'} w-full rounded border border-border/60 bg-[#10181e]/95 p-3 pb-6 shadow-2xl shadow-black/20 md:sticky md:top-4 md:block md:max-h-[calc(100vh-2rem)] md:w-72 md:shrink-0 md:overflow-y-auto md:rounded-none md:border-0 md:bg-transparent md:p-0 md:pr-3 md:pb-44 md:shadow-none`}>
          <div className="relative mb-4">
            <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2">
              <SidebarIcon name="search" />
            </span>
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search songs"
              className="h-12 w-full rounded-xl border border-border/55 bg-[#131a1f]/86 pl-12 pr-28 text-sm font-medium text-foreground outline-none placeholder:text-muted-foreground/70 shadow-[inset_0_1px_rgba(255,255,255,0.03)] focus:border-accent/55"
            />
            <label className="absolute right-3 top-1/2 flex -translate-y-1/2 cursor-pointer items-center gap-1.5 text-[11px] font-medium text-muted-foreground/70 transition hover:text-muted-foreground" title="Include notes in search">
              <input
                type="checkbox"
                checked={searchNotes}
                onChange={(event) => setSearchNotes(event.target.checked)}
                className="h-3.5 w-3.5 rounded accent-accent"
              />
              Include Notes
            </label>
          </div>
          <div className="rounded-t-xl border border-b-0 border-border/55 bg-[#131a1f]/86 p-0 shadow-[inset_0_1px_rgba(255,255,255,0.03)]">
            <button
              type="button"
              onClick={() => toggleFilterCollapsed('instruments')}
              className="flex min-h-16 w-full items-center gap-4 px-5 text-left text-sm font-medium text-foreground"
            >
              <SidebarIcon name="instruments" />
              <span className="min-w-0 flex-1">
                <span className="block">Instruments</span>
                {collapsedFilters.instruments && (selectedInstruments.length > 0 || excludedInstruments.length > 0) && (
                  <span className={collapsedSummaryClass}>{filterSummary(selectedInstruments, excludedInstruments)}</span>
                )}
              </span>
              <SidebarChevron open={!collapsedFilters.instruments} />
            </button>
            {!collapsedFilters.instruments && <div className="space-y-1 px-3 pb-3">
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
          {currentUser?.isAdmin && (
          <div className="border border-b-0 border-border/55 bg-[#131a1f]/86 p-0 shadow-[inset_0_1px_rgba(255,255,255,0.03)]">
            <button
              type="button"
              onClick={() => toggleFilterCollapsed('interactions')}
              className="flex min-h-16 w-full items-center gap-4 px-5 text-left text-sm font-medium text-foreground"
            >
              <SidebarIcon name="interactions" />
              <span className="min-w-0 flex-1">
                <span className="block">Interactions</span>
                {collapsedFilters.interactions && (selectedInteractionUsers.length > 0 || excludedInteractionUsers.length > 0) && (
                  <span className={collapsedSummaryClass}>{interactionFilterSummary(selectedInteractionUsers, excludedInteractionUsers)}</span>
                )}
              </span>
              <SidebarChevron open={!collapsedFilters.interactions} />
            </button>
            {!collapsedFilters.interactions && <div className="space-y-1 px-3 pb-3">
              {interactionUsers.length > 0 ? interactionUsers.map(user => {
                const mode = getFilterMode(user.id, selectedInteractionUsers, excludedInteractionUsers);
                return (
                <div
                  key={user.id}
                  onClick={() => toggleFilterValue(user.id, selectedInteractionUsers, setSelectedInteractionUsers, excludedInteractionUsers, setExcludedInteractionUsers)}
                  className={filterOptionClass(mode)}
                >
                  <span>{user.name}</span>
                  <span className="flex items-center gap-2">
                    {mode === 'include' && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          excludeFilterValue(user.id, setSelectedInteractionUsers, setExcludedInteractionUsers);
                        }}
                        className="inline-flex h-5 w-5 items-center justify-center rounded border border-accent-foreground/40 text-xs text-accent-foreground/80 hover:bg-accent-foreground/10"
                        aria-label={`Exclude interactions by ${user.name}`}
                      >
                        -
                      </button>
                    )}
                    {mode === 'exclude' && (
                      <span className="text-[10px] font-medium uppercase tracking-wide text-red-200/70">Excluded</span>
                    )}
                    <span className={filterCountClass(mode)}>{filterCounts.interactions.get(user.id) || 0}</span>
                  </span>
                </div>
                );
              }) : (
                <p className="rounded border border-border/50 bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground">No other users yet</p>
              )}
            </div>}
          </div>
          )}
          <div className="border border-b-0 border-border/55 bg-[#131a1f]/86 p-0 shadow-[inset_0_1px_rgba(255,255,255,0.03)]">
            <button
              type="button"
              onClick={() => toggleFilterCollapsed('vibes')}
              className="flex min-h-16 w-full items-center gap-4 px-5 text-left text-sm font-medium text-foreground"
            >
              <SidebarIcon name="vibes" />
              <span className="min-w-0 flex-1">
                <span className="block">Vibe</span>
                {collapsedFilters.vibes && (selectedVibes.length > 0 || excludedVibes.length > 0) && (
                  <span className={collapsedSummaryClass}>{filterSummary(selectedVibes, excludedVibes)}</span>
                )}
              </span>
              <SidebarChevron open={!collapsedFilters.vibes} />
            </button>
            {!collapsedFilters.vibes && <div className="space-y-1 px-3 pb-3">
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
          <div className="border border-b-0 border-border/55 bg-[#131a1f]/86 p-0 shadow-[inset_0_1px_rgba(255,255,255,0.03)]">
            <button
              type="button"
              onClick={() => toggleFilterCollapsed('adamsRatings')}
              className="flex min-h-16 w-full items-center gap-4 px-5 text-left text-sm font-medium text-foreground"
            >
              <SidebarIcon name="rating" />
              <span className="min-w-0 flex-1">
                <span className="block">{adminName}&apos;s Rating</span>
                {collapsedFilters.adamsRatings && (selectedAdamRatings.length > 0 || excludedAdamRatings.length > 0) && (
                  <span className={collapsedSummaryClass}>{ratingFilterSummary(selectedAdamRatings, excludedAdamRatings)}</span>
                )}
              </span>
              <SidebarChevron open={!collapsedFilters.adamsRatings} />
            </button>
            {!collapsedFilters.adamsRatings && <div className="space-y-1 px-3 pb-3">
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
          <div className="border border-b-0 border-border/55 bg-[#131a1f]/86 p-0 shadow-[inset_0_1px_rgba(255,255,255,0.03)]">
            <button
              type="button"
              onClick={() => toggleFilterCollapsed('collections')}
              className="flex min-h-16 w-full items-center gap-4 px-5 text-left text-sm font-medium text-foreground"
            >
              <SidebarIcon name="collections" />
              <span className="min-w-0 flex-1">
                <span className="block">Collections</span>
                {collapsedFilters.collections && (selectedCollections.length > 0 || excludedCollections.length > 0) && (
                  <span className={collapsedSummaryClass}>{filterSummary(selectedCollections, excludedCollections)}</span>
                )}
              </span>
              <SidebarChevron open={!collapsedFilters.collections} />
            </button>
            {!collapsedFilters.collections && <div className="space-y-1 px-3 pb-3">
              {collectionOptions.length > 0 ? collectionOptions.map(collection => {
                const mode = getFilterMode(collection, selectedCollections, excludedCollections);
                return (
                <div
                  key={collection}
                  onClick={() => toggleCollectionFilterValue(collection)}
                  className={filterOptionClass(mode)}
                >
                  <span>{displayTag(collection)}</span>
                  <span className="flex items-center gap-2">
                    {mode === 'include' && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          excludeCollectionFilterValue(collection);
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
          <div className="border border-b-0 border-border/55 bg-[#131a1f]/86 p-0 shadow-[inset_0_1px_rgba(255,255,255,0.03)]">
            <button
              type="button"
              onClick={() => toggleFilterCollapsed('finish')}
              className="flex min-h-16 w-full items-center gap-4 px-5 text-left text-sm font-medium text-foreground"
            >
              <SidebarIcon name="finish" />
              <span className="min-w-0 flex-1">
                <span className="block">Finish</span>
                {collapsedFilters.finish && (selectedFinishes.length > 0 || excludedFinishes.length > 0) && (
                  <span className={collapsedSummaryClass}>{filterSummary(selectedFinishes, excludedFinishes)}</span>
                )}
              </span>
              <SidebarChevron open={!collapsedFilters.finish} />
            </button>
            {!collapsedFilters.finish && <div className="space-y-1 px-3 pb-3">
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
          <div className="mb-5 rounded-b-xl border border-border/55 bg-[#131a1f]/86 p-0 shadow-[inset_0_1px_rgba(255,255,255,0.03)]">
            <button
              type="button"
              onClick={() => toggleFilterCollapsed('years')}
              className="flex min-h-16 w-full items-center gap-4 px-5 text-left text-sm font-medium text-foreground"
            >
              <SidebarIcon name="years" />
              <span className="min-w-0 flex-1">
                <span className="block">Year</span>
                {collapsedFilters.years && (selectedYears.length > 0 || excludedYears.length > 0) && (
                  <span className={collapsedSummaryClass}>{filterSummary(selectedYears, excludedYears)}</span>
                )}
              </span>
              <SidebarChevron open={!collapsedFilters.years} />
            </button>
            {!collapsedFilters.years && <div className="space-y-1 px-3 pb-3">
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
          <div className="mb-5 overflow-hidden rounded-xl border border-border/55 bg-[#131a1f]/86 shadow-[inset_0_1px_rgba(255,255,255,0.03)]">
            <label className="flex min-h-16 cursor-pointer items-center gap-4 border-b border-border/55 px-5 text-sm font-medium text-foreground transition hover:bg-muted/20">
              <SidebarIcon name="liked" />
              <span className="min-w-0 flex-1">Liked songs</span>
              <input
                type="checkbox"
                checked={likedOnly}
                onChange={(event) => setLikedOnly(event.target.checked)}
                className="h-4 w-4 accent-accent"
              />
            </label>
            {currentUser?.id === 'adam' && (
              <label className="flex min-h-16 cursor-pointer items-center gap-4 px-5 text-sm font-medium text-foreground transition hover:bg-muted/20">
                <SidebarIcon name="untagged" />
                <span className="min-w-0 flex-1">Untagged songs</span>
                <input
                  type="checkbox"
                  checked={untaggedOnly}
                  onChange={(event) => setUntaggedOnly(event.target.checked)}
                  className="h-4 w-4 accent-accent"
                />
              </label>
            )}
          </div>
          <div className="space-y-3">
            <div className="relative flex min-h-14 items-center gap-3 rounded-xl border border-border/55 bg-[#131a1f]/86 px-4 shadow-[inset_0_1px_rgba(255,255,255,0.03)]">
              <SidebarIcon name="plus" />
              <input
                type="text"
                value={newInstrument}
                onChange={(e) => setNewInstrument(e.target.value)}
                placeholder="Add instrument"
                className="min-w-0 flex-1 bg-transparent py-3 text-sm font-medium text-foreground outline-none placeholder:text-muted-foreground"
                onKeyDown={(e) => e.key === 'Enter' && addInstrument()}
              />
              <button
                type="button"
                onClick={addInstrument}
                className="rounded border border-border/45 px-2 py-1 text-xs text-muted-foreground transition hover:border-accent/45 hover:text-foreground"
              >
                Add
              </button>
              <SidebarIcon name="instruments" />
            </div>
            <div className="relative flex min-h-14 items-center gap-3 rounded-xl border border-border/55 bg-[#131a1f]/86 px-4 shadow-[inset_0_1px_rgba(255,255,255,0.03)]">
              <SidebarIcon name="plus" />
              <input
                type="text"
                value={newVibe}
                onChange={(e) => setNewVibe(e.target.value)}
                placeholder="Add vibe"
                className="min-w-0 flex-1 bg-transparent py-3 text-sm font-medium text-foreground outline-none placeholder:text-muted-foreground"
                onKeyDown={(e) => e.key === 'Enter' && addVibe()}
              />
              <button
                type="button"
                onClick={addVibe}
                className="rounded border border-border/45 px-2 py-1 text-xs text-muted-foreground transition hover:border-accent/45 hover:text-foreground"
              >
                Add
              </button>
              <SidebarIcon name="vibes" />
            </div>
          </div>
        </div>
        <div className="flex-1 md:pl-4">
          {currentUser && !currentUser.isAdmin && (
            <div className="mb-4 rounded border border-border/60 bg-muted/25 p-3">
              <button
                type="button"
                onClick={() => setShowInbox(prev => !prev)}
                className="flex w-full items-center justify-between gap-3 text-left"
                aria-expanded={showInbox}
              >
                <span className="flex items-center gap-2">
                  <h2 className="text-sm font-medium text-foreground">Inbox</h2>
                  {unreadInboxCount > 0 && (
                    <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold text-accent-foreground">
                      {unreadInboxCount} new
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-3 text-xs text-muted-foreground">
                  {inboxMessages.length} item{inboxMessages.length === 1 ? '' : 's'}
                  <span>{showInbox ? '-' : '+'}</span>
                </span>
              </button>
              {showInbox && inboxMessages.length > 0 && (
                <div className="mt-3 max-h-[22rem] divide-y divide-border/50 overflow-y-auto border-y border-border/50">
                  {inboxMessages.map(message => {
                    const songAvailable = Boolean(findProjectForFileId(files, message.songId));
                    return (
                      <div
                        key={message.id}
                        className={`flex items-stretch transition ${
                          message.readAt ? 'bg-transparent' : 'bg-accent/[0.07]'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => showInboxTrack(message)}
                          className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left transition hover:bg-background/60"
                        >
                          <span className={`w-20 shrink-0 text-[10px] font-medium uppercase tracking-wide ${message.readAt ? 'text-muted-foreground/70' : 'text-accent'}`}>
                            {message.readAt ? 'Message' : 'New message'}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className={`truncate text-sm ${message.readAt ? 'text-foreground/80' : 'font-medium text-foreground'}`}>
                              {message.songName}
                              {!songAvailable && <span className="ml-1 text-xs font-normal text-muted-foreground">(song unavailable)</span>}
                            </p>
                            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                              <span>From {message.senderName}</span>
                              {message.note && <span className="break-words text-foreground/75">{message.note}</span>}
                            </div>
                          </div>
                          <span className="shrink-0 text-[10px] text-muted-foreground/75">
                            {formatActivityTime(message.sentAt)}
                          </span>
                        </button>
                        {!message.readAt && (
                          <button
                            type="button"
                            onClick={() => void markInboxMessageRead(message)}
                            className="flex w-12 shrink-0 items-center justify-center border-l border-border/45 text-muted-foreground transition hover:bg-background/60 hover:text-accent"
                            title="Mark as read"
                            aria-label={`Mark ${message.songName} message as read`}
                          >
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m5 12 4 4L19 6" />
                            </svg>
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {showInbox && inboxMessages.length === 0 && (
                <p className="mt-3 text-sm text-muted-foreground">No songs have been sent to you yet.</p>
              )}
            </div>
          )}
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
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-t-md border border-b-0 border-border/65 bg-[#13191e]/95 px-3 py-2 shadow-sm shadow-black/10">
            <div className="inline-flex flex-wrap overflow-hidden rounded border border-border/65 bg-background/40">
              <button
                type="button"
                onClick={pickRandomTracks}
                className={`inline-flex min-h-9 items-center gap-2 border-r border-border/65 px-4 py-1.5 text-sm transition ${
                  randomTrackIds
                    ? 'bg-accent text-accent-foreground hover:bg-accent/90'
                    : 'text-foreground hover:bg-muted/40'
                }`}
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M16 3h5v5M4 20l7-7m3-3 7-7M21 16v5h-5M15 15l6 6M4 4l5 5" />
                </svg>
                Random
              </button>
              <label className="flex min-h-9 cursor-pointer items-center gap-2 border-r border-border/65 px-3 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={randomIncludeVoiceMemos}
                  onChange={(event) => setVoiceMemosIncluded(event.target.checked)}
                  className="h-3.5 w-3.5 accent-accent"
                />
                Voice memos
              </label>
              {randomTrackIds && (
                <button
                  type="button"
                  onClick={() => setRandomTrackIds(null)}
                  className="min-h-9 px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-muted/40 hover:text-foreground"
                >
                  All
                </button>
              )}
            </div>
            <div className="flex flex-1 flex-wrap items-center justify-end gap-2 sm:flex-none">
              <label className="text-sm text-muted-foreground">Sort by:</label>
              <select
                value={sortBy === 'adamsRatingRandom' ? 'adamsRating' : sortBy}
                onChange={(e) => setSortBy(e.target.value as SortBy)}
                className="min-h-9 flex-1 rounded border border-border/65 bg-background/40 px-3 py-1.5 text-sm text-foreground outline-none transition focus:border-accent/60 sm:flex-none"
              >
                <option value="random">Random</option>
                <option value="name">Name</option>
                <option value="date">Date</option>
                <option value="uploadDate">Date Added</option>
                <option value="adamsRating">{adminName}&apos;s Rating</option>
                <option value="userRating">User Rating</option>
              </select>
              <button
                onClick={() => {
                  if (sortBy === 'adamsRatingRandom') {
                    setSortBy('adamsRating');
                  }
                  setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
                }}
                className="min-h-9 rounded border border-border/65 bg-background/40 px-3 py-1.5 text-sm text-muted-foreground transition hover:border-accent/40 hover:text-foreground"
              >
                {sortDirection === 'asc' ? '↑' : '↓'}
              </button>
            </div>
          </div>
          <div className="overflow-visible rounded-b-md border border-border/65 bg-[#0b0f14]/92 shadow-2xl shadow-black/20">
            {displayedFiles.map(file => {
              const hiddenActiveTrack = Boolean(activeTrack && getProjectId(activeTrack) === file.id && !visibleFileIds.has(file.id));
              if (!currentUser) return null;

              return (
                <div
                  key={file.id}
                  className={hiddenActiveTrack ? 'hidden' : undefined}
                  ref={(element) => {
                    if (!element || file.id !== targetTrackId) return;
                    window.setTimeout(() => {
                      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      if (activityTargetTrackId === file.id && visibleFileIds.has(file.id)) {
                        setActivityTargetTrackId(null);
                      }
                    }, 100);
                  }}
                >
                  <AudioCard
                    file={file}
                    setFiles={setFiles}
                    isActive={Boolean(activeTrack && getProjectId(activeTrack) === file.id)}
                    currentUser={currentUser}
                    accountUsers={accountUsers}
                    instrumentOptions={instrumentOptions}
                    vibeOptions={vibeOptions}
                    collectionOptions={collectionOptions}
                    linkableSongs={files}
                    shouldPreloadPlayback={playbackPreloadFileIds.has(file.id)}
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
        <div className="fixed bottom-3 left-3 right-3 z-50 rounded-md border border-border/70 bg-[#10181e]/95 p-2 shadow-2xl shadow-black/45 backdrop-blur sm:bottom-4 sm:left-4 sm:right-4 sm:p-3 md:right-auto md:w-[min(360px,calc(100vw-2rem))]">
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
                className="mt-2 h-3 w-full cursor-pointer overflow-hidden rounded-full border border-border/30 bg-[#0b0f14]"
                onPointerDown={seekMiniPlayer}
                role="slider"
                aria-label={`Seek ${activeTrack.name}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress)}
              >
                <div className="h-full bg-accent transition-all duration-200" style={{ width: `${progress}%` }} />
              </div>
              <label className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                <span className="shrink-0">Vol</span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={miniVolume}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                  onInput={(event) => updateMiniVolume(Number(event.currentTarget.value))}
                  onChange={(event) => updateMiniVolume(Number(event.currentTarget.value))}
                  className="h-1.5 min-w-0 flex-1 accent-accent"
                  aria-label={`Volume for ${activeTrack.name}`}
                />
                <span className="w-8 shrink-0 text-right tabular-nums">{Math.round(miniVolume * 100)}</span>
              </label>
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
