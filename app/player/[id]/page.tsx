'use client';

import { useEffect, useRef, useState, use } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { isValidWaveformCache } from '@/lib/waveform';

declare global {
  var waveSurfers: WaveSurfer[];
  var currentActiveWaveSurfer: WaveSurfer | null;
}

const DEFAULT_INSTRUMENTS = ['E. Guitar', 'Keys', 'Vocal', 'Synth', 'Acoustic', 'Bass', 'Drums', 'Drum Machine', 'Uku'];
const DEFAULT_VIBES = ['ambient', 'rock', 'indie', 'acoustic', 'hard', 'soft', 'country', 'electronic', 'Chill', 'Gainy', 'Spacey', 'Beats', 'Group Jam'];
const MOBILE_PLACEHOLDER_WAVEFORM_PEAKS = [[0, 0]];
const MOBILE_PLACEHOLDER_DURATION = 0.001;
const TAG_LABELS: Record<string, string> = {
  'electric guitar': 'E. Guitar',
  'e. guitar': 'E. Guitar',
  'acoustic guitar': 'Acoustic',
};

const displayTag = (tag: string) => TAG_LABELS[tag.toLowerCase()] || tag.replace(/\b\w/g, char => char.toUpperCase());
const normalizeTag = (tag: string) => TAG_LABELS[tag.toLowerCase()] || tag;

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

interface AudioFile {
  id: string;
  name: string;
  instrument?: string;
  vibe?: string;
  instruments?: string[];
  vibes?: string[];
  finish?: string;
  waveformPeaks?: number[][];
  waveformDuration?: number;
  waveformCacheVersion?: number;
  year?: number;
  ratings?: Record<string, number>;
  myRating: number;
  userRating: number;
  comments: { text: string; timestamp?: number }[];
  uploadedAt: string;
}

interface ArchiveUser {
  id: string;
  name: string;
  isAdmin: boolean;
}

const getTags = (file: AudioFile, pluralKey: 'instruments' | 'vibes', singularKey: 'instrument' | 'vibe') => {
  const tags = file[pluralKey];
  if (Array.isArray(tags) && tags.length > 0) return tags.filter(Boolean).map(normalizeTag);
  const tag = file[singularKey];
  return tag ? [normalizeTag(tag)] : [];
};

const getPlayableDuration = (wavesurfer: WaveSurfer) => {
  const mediaDuration = wavesurfer.getMediaElement().duration;
  if (Number.isFinite(mediaDuration) && mediaDuration > 0) return mediaDuration;

  const duration = wavesurfer.getDuration();
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
};

const seekToProgress = (wavesurfer: WaveSurfer, progress: number) => {
  const duration = getPlayableDuration(wavesurfer);
  wavesurfer.setTime(Math.min(1, Math.max(0, progress)) * duration);
};

export default function PlayerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [file, setFile] = useState<AudioFile | null>(null);
  const [currentUser, setCurrentUser] = useState<ArchiveUser | null>(null);
  const [accountUsers, setAccountUsers] = useState<ArchiveUser[]>([]);
  const [editInstruments, setEditInstruments] = useState<string[]>([]);
  const [editVibes, setEditVibes] = useState<string[]>([]);
  const [instrumentOptions, setInstrumentOptions] = useState<string[]>(DEFAULT_INSTRUMENTS);
  const [vibeOptions, setVibeOptions] = useState<string[]>(DEFAULT_VIBES);
  const [editMyRating, setEditMyRating] = useState(0);
  const [newComment, setNewComment] = useState('');
  const waveformRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);

  const handleUpdate = async () => {
    if (!file) return;
    const updatedFile: AudioFile = {
      ...file,
      instrument: editInstruments[0] || '',
      vibe: editVibes[0] || '',
      instruments: editInstruments,
      vibes: editVibes,
      myRating: editMyRating,
      ratings: { ...(file.ratings || {}), adam: editMyRating },
    };
    await updateFile(updatedFile);
    setFile(updatedFile);
  };

  useEffect(() => {
    fetch('/api/session')
      .then(res => res.json())
      .then((data: { user: ArchiveUser | null; users: ArchiveUser[] }) => {
        setCurrentUser(data.user);
        setAccountUsers(data.users);
      });

    fetch('/api/files')
      .then(res => res.json())
      .then((files: AudioFile[]) => {
        const updatedFiles = files.map(f => ({ ...f, year: f.year || new Date().getFullYear() }));
        const f = updatedFiles.find(f => f.id === id);
        setInstrumentOptions(prev => Array.from(new Set([...prev, ...updatedFiles.flatMap(file => getTags(file, 'instruments', 'instrument'))])));
        setVibeOptions(prev => Array.from(new Set([...prev, ...updatedFiles.flatMap(file => getTags(file, 'vibes', 'vibe'))])));
        setFile(f || null);
        if (f) {
          setEditInstruments(getTags(f, 'instruments', 'instrument'));
          setEditVibes(getTags(f, 'vibes', 'vibe'));
          setEditMyRating(f.ratings?.adam || f.myRating);
        }
      });
  }, [id]);

  // Global spacebar to pause/resume current audio
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault();
        if (globalThis.currentActiveWaveSurfer) {
          if (globalThis.currentActiveWaveSurfer.isPlaying()) {
            globalThis.currentActiveWaveSurfer.pause();
          } else {
            globalThis.currentActiveWaveSurfer.play();
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (file && waveformRef.current) {
      const cachedWaveform = isValidWaveformCache(file.waveformPeaks, file.waveformDuration, file.waveformCacheVersion);
      const useMobileStreamingFallback = !cachedWaveform && isMobilePlaybackDevice();
      wavesurferRef.current = WaveSurfer.create({
        container: waveformRef.current,
        waveColor: '#a3a3a3',
        progressColor: '#5e9ec5',
        interact: false, // Disable default interact to handle click manually
        backend: 'MediaElement',
        url: getPlaybackAudioUrl(file.id),
        peaks: cachedWaveform ? file.waveformPeaks : useMobileStreamingFallback ? MOBILE_PLACEHOLDER_WAVEFORM_PEAKS : undefined,
        duration: cachedWaveform ? file.waveformDuration : useMobileStreamingFallback ? MOBILE_PLACEHOLDER_DURATION : undefined,
      });
      const mediaElement = wavesurferRef.current.getMediaElement();
      mediaElement.preload = 'auto';
      mediaElement.setAttribute('playsinline', '');

      if (useMobileStreamingFallback) {
        const applyMetadataDuration = () => {
          const mediaDuration = mediaElement.duration;
          if (!Number.isFinite(mediaDuration) || mediaDuration <= 0) return;

          wavesurferRef.current?.setOptions({
            peaks: MOBILE_PLACEHOLDER_WAVEFORM_PEAKS,
            duration: mediaDuration,
          });
          mediaElement.removeEventListener('loadedmetadata', applyMetadataDuration);
          mediaElement.removeEventListener('canplay', applyMetadataDuration);
        };

        mediaElement.addEventListener('loadedmetadata', applyMetadataDuration);
        mediaElement.addEventListener('canplay', applyMetadataDuration);
      }

      // Add to global list
      if (!globalThis.waveSurfers) globalThis.waveSurfers = [];
      globalThis.waveSurfers.push(wavesurferRef.current);

      // Event listeners for debugging
      wavesurferRef.current.on('ready', () => console.log('WaveSurfer ready for', file.id));
      wavesurferRef.current.on('error', (err) => console.error('WaveSurfer error for', file.id, err));
      wavesurferRef.current.on('pause', () => console.log('Paused', file.id));

      // When this starts playing, pause others
      wavesurferRef.current.on('play', () => {
        console.log('Playing', file.id);
        globalThis.currentActiveWaveSurfer = wavesurferRef.current;
        globalThis.waveSurfers.forEach(ws => {
          if (ws !== wavesurferRef.current && ws.isPlaying()) {
            ws.pause();
          }
        });
      });

      return () => {
        if (wavesurferRef.current) {
          // Remove from global list
          globalThis.waveSurfers = globalThis.waveSurfers.filter(ws => ws !== wavesurferRef.current);
          wavesurferRef.current.destroy();
          wavesurferRef.current = null;
        }
      };
    }
  }, [file]);

  const handleAddComment = async () => {
    if (!file || !newComment) return;
    const updatedComments = [...file.comments, { text: newComment }];
    await updateFile({ ...file, comments: updatedComments });
    setFile({ ...file, comments: updatedComments });
    setNewComment('');
  };

  const updateFile = async (updatedFile: AudioFile) => {
    await fetch(`/api/files/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedFile),
    });
  };

  const updateRating = async (userId: string, rating: number) => {
    const res = await fetch(`/api/files/${encodeURIComponent(id)}/rating`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, rating }),
    });
    if (!res.ok || !file) return;
    const ratingData = await res.json() as Pick<AudioFile, 'ratings' | 'myRating' | 'userRating'>;
    setFile({ ...file, ...ratingData });
  };

  if (!file) return <div className="bg-background text-foreground min-h-screen flex items-center justify-center">Loading...</div>;

  const instruments = getTags(file, 'instruments', 'instrument');
  const vibes = getTags(file, 'vibes', 'vibe');
  const toggleInstrument = (tag: string) => {
    setEditInstruments(prev => prev.includes(tag) ? prev.filter(item => item !== tag) : [...prev, tag]);
  };
  const toggleVibe = (tag: string) => {
    setEditVibes(prev => prev.includes(tag) ? prev.filter(item => item !== tag) : [...prev, tag]);
  };

  return (
    <div className="container mx-auto p-4 bg-background text-foreground min-h-screen">
      <h1 className="text-2xl font-bold mb-4">{file.name}</h1>
      <div ref={waveformRef} className="mb-4 cursor-pointer" onClick={(e) => {
        if (wavesurferRef.current) {
          const rect = wavesurferRef.current.getWrapper().getBoundingClientRect();
          const x = e.clientX - rect.left;
          const progress = x / rect.width;
          seekToProgress(wavesurferRef.current, progress);
          wavesurferRef.current.play();
        }
      }}></div>
      <button 
        onClick={() => wavesurferRef.current?.stop()} 
        className="bg-red-500 text-white px-4 py-2 rounded hover:bg-red-600 mb-4 flex items-center justify-center"
      >
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
          <path d="M6 4h8v12H6V4z"/>
        </svg>
      </button>
      <div className="mb-4">
        <p className="text-muted-foreground">Instrument: {instruments.map(displayTag).join(', ') || 'None'}</p>
        <p className="text-muted-foreground">Vibe: {vibes.map(displayTag).join(', ') || 'None'}</p>
        <p className="text-muted-foreground">Finish: {file.finish || 'None'}</p>
        <p className="text-muted-foreground">Year: {file.year || 'N/A'}</p>
        <p className="text-muted-foreground">Adam&apos;s Rating: {file.ratings?.adam || file.myRating}/5</p>
        {currentUser && currentUser.id !== 'adam' && (
          <p className="text-muted-foreground">Your Rating: {file.ratings?.[currentUser.id] || file.userRating}/5</p>
        )}
      </div>
      {currentUser?.isAdmin && <div className="mb-4">
        <label className="block text-sm font-medium mb-2 text-foreground">Instrument</label>
        <div className="flex flex-wrap gap-2">
          {instrumentOptions.map(option => (
            <button
              key={option}
              type="button"
              onClick={() => toggleInstrument(option)}
              className={`rounded px-2 py-1 text-sm transition ${editInstruments.includes(option) ? 'bg-accent text-accent-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80'}`}
            >
              {displayTag(option)}
            </button>
          ))}
        </div>
        <label className="block text-sm font-medium mb-2 mt-2 text-foreground">Vibe</label>
        <div className="flex flex-wrap gap-2">
          {vibeOptions.map(option => (
            <button
              key={option}
              type="button"
              onClick={() => toggleVibe(option)}
              className={`rounded px-2 py-1 text-sm transition ${editVibes.includes(option) ? 'bg-accent text-accent-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80'}`}
            >
              {displayTag(option)}
            </button>
          ))}
        </div>
        <label className="block text-sm font-medium mb-2 mt-2 text-foreground">Adam&apos;s Rating</label>
        <RatingInput value={editMyRating} onChange={setEditMyRating} />
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {accountUsers.filter(user => user.id !== 'adam' && (file.ratings?.[user.id] || 0) > 0).map(user => (
            <div key={user.id}>
              <label className="block text-sm font-medium mb-2 text-foreground">{user.name}</label>
              <RatingInput value={file.ratings?.[user.id] || 0} onChange={(rating) => updateRating(user.id, rating)} />
            </div>
          ))}
        </div>
        <button onClick={handleUpdate} className="mt-2 bg-accent text-accent-foreground px-4 py-2 rounded hover:bg-accent/80">
          Update
        </button>
      </div>}
      {currentUser && !currentUser.isAdmin && (
        <div className="mb-4">
          <label className="block text-sm font-medium mb-2 text-foreground">Your Rating</label>
          <RatingInput value={file.ratings?.[currentUser.id] || file.userRating} onChange={(rating) => updateRating(currentUser.id, rating)} />
        </div>
      )}
      {currentUser?.isAdmin && <div className="mb-4">
        <h2 className="text-lg font-semibold text-foreground">Comments</h2>
        {file.comments.map((c, i) => (
          <p key={i} className="text-muted-foreground">{c.text}</p>
        ))}
        <textarea
          value={newComment}
          onChange={(e) => setNewComment(e.target.value)}
          className="w-full p-2 border border-border rounded bg-background text-foreground"
          placeholder="Add a comment"
        />
        <button onClick={handleAddComment} className="mt-2 bg-accent text-accent-foreground px-4 py-2 rounded hover:bg-accent/80">
          Add Comment
        </button>
      </div>}
    </div>
  );
}
