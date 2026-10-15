'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import s from './preview.module.css';
import RecordingPlayer from './recording-player';
import { WAVEFORM_CACHE_VERSION } from '@/lib/waveform';

type Song = { id: number; recordingId: string; playbackId: string; name: string; instrument: string; vibe: string; finish: string; year: string; collection: string; versions: number; duration: string; waveform: boolean; stems: boolean; notes: string };
type Section = 'Library' | 'Collections' | 'Activity' | 'Maintenance';
type LibraryRecording = {
  id: string;
  name: string;
  defaultVersionId?: string;
  instrument?: string;
  instruments?: string[];
  vibe?: string;
  vibes?: string[];
  finish?: string;
  year?: number;
  collections?: string[];
  uploads?: LibraryRecording[];
  waveformDuration?: number;
  waveformAvailable?: boolean;
  waveformCacheVersion?: number;
  stems?: unknown;
  notes?: string;
  uploadedAt?: string;
};

function toSong(recording: LibraryRecording, index: number): Song {
  const playback = recording.uploads?.find(version => version.id === recording.defaultVersionId) || recording;
  const duration = playback.waveformDuration || 0;
  return {
    id: index + 1,
    recordingId: recording.id,
    playbackId: playback.id,
    name: recording.name,
    instrument: (recording.instruments || [recording.instrument || '']).join(', '),
    vibe: (recording.vibes || [recording.vibe || '']).join(', '),
    finish: recording.finish || '',
    year: String(recording.year || ''),
    collection: (recording.collections || []).join(', '),
    versions: 1 + (recording.uploads?.length || 0),
    duration: duration ? `${Math.floor(duration / 60)}:${Math.floor(duration % 60).toString().padStart(2, '0')}` : '—',
    waveform: Boolean(playback.waveformAvailable && playback.waveformCacheVersion === WAVEFORM_CACHE_VERSION),
    stems: Boolean(recording.stems),
    notes: recording.notes || '',
  };
}

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    library: <><rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h4"/></>,
    collections: <><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"/><path d="M3 11h18"/></>,
    activity: <><path d="m3 12 4 0 3-8 4 16 3-8h4"/></>,
    maintenance: <><path d="m14 6 4 4M4 20l7-7M14 3a6 6 0 0 0-7 8L3 15a3 3 0 0 0 6 6l4-4a6 6 0 0 0 8-7l-5 5-4-4 5-5Z"/></>,
    search: <><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></>,
    arrow: <path d="m9 5 7 7-7 7"/>,
    back: <path d="m15 5-7 7 7 7"/>,
    plus: <path d="M12 4v16M4 12h16"/>,
    export: <><path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    close: <path d="m6 6 12 12M6 18 18 6"/>,
    music: <><path d="M9 17V5l11-2v12M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="17" cy="16" rx="3" ry="2"/></>,
    users: <><circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-17a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5v2"/></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.library}</svg>;
}

function Wave({ seed, muted = false }: { seed: number; muted?: boolean }) {
  return <svg className={`${s.wave} ${muted ? s.mutedWave : ''}`} viewBox="0 0 100 30" aria-hidden="true">{Array.from({ length: 38 }, (_, i) => {
    const height = 3 + Math.abs(Math.sin(i * 2.7 + seed) * Math.cos(i * .39 + seed)) * 24;
    return <line key={i} x1={(i * 2.6 + 1).toFixed(2)} x2={(i * 2.6 + 1).toFixed(2)} y1={(15 - height / 2).toFixed(2)} y2={(15 + height / 2).toFixed(2)} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>;
  })}</svg>;
}

export default function ManagementPreview() {
  const [songs, setSongs] = useState<Song[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [section, setSection] = useState<Section>('Library');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [finish, setFinish] = useState('all');
  const [sort, setSort] = useState('recent');
  const [selected, setSelected] = useState<number[]>([]);
  const [editing, setEditing] = useState<Song | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkCollection, setBulkCollection] = useState('Late night ideas');
  const [toast, setToast] = useState('');
  const [undo, setUndo] = useState<Song[] | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const activities = useMemo(() => songs.slice(0, 4).map(song => ({ initials: '♫', name: '', action: 'Added', song: song.name, detail: `${song.versions} ${song.versions === 1 ? 'version' : 'versions'}`, time: '', id: song.id })), [songs]);
  const missingTags = songs.filter(song => !song.instrument || !song.vibe);
  const missingWaves = songs.filter(song => !song.waveform);
  const needsAttention = songs.filter(song => !song.instrument || !song.vibe || !song.waveform);
  const collections = Array.from(new Set(songs.map(song => song.collection).filter(Boolean)));
  const visible = songs.filter(song => `${song.name} ${song.instrument} ${song.vibe} ${song.collection} ${song.notes}`.toLowerCase().includes(query.toLowerCase()))
    .filter(song => finish === 'all' || song.finish === finish)
    .filter(song => filter === 'all' || (filter === 'attention' && needsAttention.includes(song)) || (filter === 'tags' && missingTags.includes(song)) || (filter === 'waveforms' && !song.waveform) || (filter === 'stems' && song.stems))
    .sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'versions' ? b.versions - a.versions : a.id - b.id);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/files?view=metadata', { signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error('Library unavailable.'); return response.json() as Promise<LibraryRecording[]>; })
      .then(recordings => { if (!controller.signal.aborted) { setSongs(recordings.map(toSong)); setLoading(false); } })
      .catch(() => { if (!controller.signal.aborted) { setLoadError('Library unavailable.'); setLoading(false); } });
    return () => controller.abort();
  }, [loadAttempt]);

  useEffect(() => {
    if (editing || bulkOpen) dialog.current?.showModal();
    else dialog.current?.close();
  }, [editing, bulkOpen]);
  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(''), 6000);
    return () => clearTimeout(timeout);
  }, [toast]);

  function notify(message: string) { setUndo(null); setToast(message); }
  function changeSongs(next: Song[], message: string) { setUndo(songs); setSongs(next); setToast(message); }
  function showLibrary(nextFilter: string) { setSection('Library'); setFilter(nextFilter); setFinish('all'); setQuery(''); }
  function exportCsv() {
    const rows = [['Title', 'Instrument', 'Vibe', 'Finish', 'Year', 'Collection', 'Versions'], ...visible.map(song => [song.name, song.instrument, song.vibe, song.finish, song.year, song.collection, song.versions])];
    const url = URL.createObjectURL(new Blob([rows.map(row => row.map(cell => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'archive-demo-library.csv'; link.click(); URL.revokeObjectURL(url);
    notify('CSV exported.');
  }
  function closeDialog() { setEditing(null); setBulkOpen(false); }

  return <div className={`archive-shell ${s.shell}`}>
    <header className={s.header}>
      <Link href="/" className={s.back}><Icon name="back" size={15}/> Back to archive</Link>
      <Link href="/" className={s.brand} aria-label="The archive homepage">
        <svg viewBox="0 0 120 44" aria-hidden="true"><path d="M4 22h11l5-9 6 18 7-28 8 38 8-26 6 11 5-16 5 30 8-36 7 27 6-14 5 5h24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 22h112" stroke="#dce7f3" strokeWidth="2"/></svg>
        <span>the <em>archive</em></span>
      </Link>
      <div className={s.headerActions}><span className={s.previewBadge}>Design preview</span><span className={s.avatar}>AD</span></div>
    </header>
    <div className={s.layout}>
      <aside className={s.sidebar}>
        <div className={s.sideLabel}>WORKSPACE</div>
        <nav aria-label="Management sections">{(['Library', 'Collections', 'Activity', 'Maintenance'] as Section[]).map(item => <button key={item} className={`${s.navItem} ${section === item ? s.navActive : ''}`} onClick={() => setSection(item)} aria-current={section === item ? 'page' : undefined}><Icon name={item.toLowerCase()}/><span>{item}</span>{item === 'Library' ? <small>{songs.length}</small> : item === 'Maintenance' && needsAttention.length > 0 ? <span className={s.navDot}/> : null}</button>)}</nav>
        <div className={s.sideLabel}>ADMINISTRATION</div>
        <Link href="/users" className={s.navItem}><Icon name="users"/><span>Members & access</span><Icon name="arrow" size={13}/></Link>
        <Link href="/manage" className={s.navItem}><Icon name="shield"/><span>Current manager</span><Icon name="arrow" size={13}/></Link>

        <div className={s.demoNote}>Preview edits · session only</div>
      </aside>
      <main className={s.main}>
        {loading && <p role="status">Loading recordings…</p>}
        {loadError && <p role="alert">{loadError} <button className={s.secondary} onClick={() => { setLoading(true); setLoadError(''); setLoadAttempt(value => value + 1); }}>Retry</button></p>}
        <div className={s.heading}><h1>Management</h1><Link href="/upload" className={s.primary}><Icon name="plus"/> Upload recordings</Link></div>
        <div className={s.stats}>
          {[{ label: 'Song projects', value: songs.length, sub: `${songs.reduce((n, song) => n + song.versions, 0)} recordings across all versions`, icon: 'music', action: 'all' }, { label: 'Collections', value: collections.length, icon: 'collections', action: 'collections' }, { label: 'With stems', value: songs.filter(song => song.stems).length, icon: 'library', action: 'stems' }, { label: 'Needs attention', value: needsAttention.length, icon: 'maintenance', action: 'attention' }].map(stat => <button key={stat.label} className={`${s.stat} ${stat.action === 'attention' ? s.attentionStat : ''}`} onClick={() => stat.action === 'collections' ? setSection('Collections') : showLibrary(stat.action)}><div><span>{stat.label}</span><Icon name={stat.icon}/></div><strong>{stat.value.toString().padStart(2, '0')}</strong>{'sub' in stat && <p>{stat.sub}</p>}</button>)}
        </div>
        <div className={s.contentGrid}>
          <section className={s.content} aria-label={section}>
            <div className={s.sectionHead}><div><h2>{section === 'Library' ? 'Recordings' : section}</h2></div>{section === 'Library' && <button className={s.secondary} onClick={exportCsv}><Icon name="export" size={15}/>Export CSV</button>}</div>
            {section === 'Library' && <>
              <div className={s.tabs} role="group" aria-label="Library views">{[['all', 'All recordings', songs.length], ['attention', 'Needs attention', needsAttention.length], ['stems', 'With stems', songs.filter(song => song.stems).length]].map(([value, label, count]) => <button key={value} onClick={() => setFilter(String(value))} className={filter === value ? s.tabActive : ''}>{label}<span>{count}</span></button>)}</div>
              <div className={s.toolbar}><label className={s.search}><Icon name="search" size={17}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search recordings, tags, notes…" aria-label="Search recordings"/>{query && <button onClick={() => setQuery('')} aria-label="Clear search"><Icon name="close" size={14}/></button>}</label><select aria-label="Filter by recording type" value={finish} onChange={event => setFinish(event.target.value)}><option value="all">All types</option>{['Tracked', 'Recorder', 'Voice Memo'].map(type => <option key={type}>{type}</option>)}</select><select aria-label="Sort recordings" value={sort} onChange={event => setSort(event.target.value)}><option value="recent">Recently added</option><option value="name">Title A–Z</option><option value="versions">Most versions</option></select></div>
              {selected.length > 0 && <div className={s.bulkBar}><span><strong>{selected.length}</strong> selected</span><button onClick={() => setBulkOpen(true)}><Icon name="collections" size={15}/>Add to collection</button><button onClick={() => { changeSongs(songs.map(song => selected.includes(song.id) ? { ...song, waveform: true } : song), 'Sample waveforms rebuilt.'); setSelected([]); }}>Rebuild waveforms</button><button onClick={() => setSelected([])} aria-label="Clear selection"><Icon name="close" size={15}/></button></div>}
              <div className={s.tableScroll}><table className={s.table}><thead><tr><th><input type="checkbox" aria-label="Select all visible recordings" checked={visible.length > 0 && visible.every(song => selected.includes(song.id))} onChange={event => setSelected(event.target.checked ? Array.from(new Set([...selected, ...visible.map(song => song.id)])) : selected.filter(id => !visible.some(song => song.id === id)))}/></th><th>RECORDING</th><th>TYPE / YEAR</th><th>WAVEFORM</th><th>STATUS</th><th><span className={s.srOnly}>Edit</span></th></tr></thead><tbody>{visible.map(song => <tr key={song.id} className={selected.includes(song.id) ? s.selectedRow : ''}><td><input type="checkbox" aria-label={`Select ${song.name}`} checked={selected.includes(song.id)} onChange={event => setSelected(prev => event.target.checked ? [...prev, song.id] : prev.filter(id => id !== song.id))}/></td><td><button className={s.songTitle} onClick={() => setEditing({ ...song })}>{song.name}</button><div className={s.songTags}>{song.instrument || song.vibe ? [song.instrument, song.vibe].filter(Boolean).map(tag => <span key={tag}>{tag}</span>) : <i>No tags yet</i>}<small>{song.versions} {song.versions === 1 ? 'version' : 'versions'}</small></div></td><td><select className={s.inlineType} aria-label={`Type for ${song.name}`} value={song.finish} onChange={event => changeSongs(songs.map(recording => recording.id === song.id ? { ...recording, finish: event.target.value } : recording), 'Type updated.')}>
                  {!['Tracked', 'Recorder', 'Voice Memo'].includes(song.finish) && <option value={song.finish}>{song.finish || 'Unspecified'}</option>}{['Tracked', 'Recorder', 'Voice Memo'].map(type => <option key={type}>{type}</option>)}
                </select><small className={s.year}>{song.year}</small></td><td><div className={s.waveCell}><Wave seed={song.id} muted={!song.waveform}/><small>{song.duration}</small></div></td><td>{!song.waveform ? <span className={s.warning}>Missing waveform</span> : !song.instrument || !song.vibe ? <span className={s.warning}>Needs tags</span> : <span className={s.ready}><span/>Ready</span>}{song.stems && <small className={s.stems}>Stems attached</small>}</td><td><button className={s.editButton} aria-label={`Edit ${song.name}`} onClick={() => setEditing({ ...song })}><Icon name="arrow" size={16}/></button></td></tr>)}</tbody></table></div>
              {visible.length === 0 && !loading && !loadError && <div className={s.empty}><Icon name="search" size={28}/><h3>No recordings found</h3><button className={s.secondary} onClick={() => showLibrary('all')}>Clear filters</button></div>}
              <footer className={s.tableFooter}><span>Showing {visible.length} of {songs.length} projects</span><span>Preview</span></footer>
            </>}
            {section === 'Collections' && <div className={s.collectionGrid}>{collections.map((collection, i) => <button key={collection} className={s.collectionCard} onClick={() => { showLibrary('all'); setQuery(collection); }}><div className={s.collectionArt}><Wave seed={i + 8}/><Icon name="collections" size={26}/></div><h3>{collection}</h3><p>{songs.filter(song => song.collection === collection).length} projects <Icon name="arrow" size={14}/></p></button>)}</div>}
            {section === 'Activity' && <div className={s.activityList}>{activities.map((activity, i) => <div key={i} className={s.activity}><span className={s.avatar}>{activity.initials}</span><div><p><strong>{activity.name}</strong> {activity.action} <button onClick={() => setEditing({ ...songs.find(song => song.id === activity.id)! })}>{activity.song}</button></p><blockquote>{activity.detail}</blockquote><small>{activity.time}</small></div></div>)}</div>}
            {section === 'Maintenance' && <div className={s.maintenanceList}><div className={s.maintenanceItem}><Icon name="activity" size={26}/><div><h3>Waveform cache</h3><p>{songs.length - missingWaves.length} of {songs.length} cached</p></div><button className={s.secondary} disabled={missingWaves.length === 0} onClick={() => changeSongs(songs.map(song => ({ ...song, waveform: true })), 'Waveforms rebuilt.')}>Rebuild missing</button></div><div className={s.maintenanceItem}><Icon name="export" size={26}/><div><h3>Metadata export</h3></div><button className={s.secondary} onClick={exportCsv}>Export CSV</button></div><div className={s.maintenanceItem}><Icon name="shield" size={26}/><div><h3>Backup & restore</h3></div><span className={s.proposed}>Proposed</span></div><div className={s.maintenanceItem}><Icon name="library" size={26}/><div><h3>Duplicate finder</h3></div><span className={s.proposed}>Proposed</span></div></div>}
          </section>
          <aside className={s.rightRail}>
            <section className={s.health}><div className={s.railHeading}><Icon name="shield"/><h2>Archive health</h2><span className={s.liveDot}/></div><div className={s.healthNumber}>{Math.round(songs.length ? (songs.length - needsAttention.length) / songs.length * 100 : 0)}<span>%</span><small>Complete</small></div><div className={s.progress}><span style={{ width: `${songs.length ? (songs.length - needsAttention.length) / songs.length * 100 : 0}%` }}/></div><button onClick={() => showLibrary('tags')}><span className={s.amberDot}/><span>Missing tags</span><b>{missingTags.length}</b><Icon name="arrow" size={13}/></button><button onClick={() => showLibrary('waveforms')}><span className={s.amberDot}/><span>Missing waveforms</span><b>{missingWaves.length}</b><Icon name="arrow" size={13}/></button><button onClick={() => { setSection('Library'); setFilter('all'); setQuery(''); setFinish('all'); notify('Audio checks are not connected in this preview.'); }}><span className={s.liveDot}/><span>Missing audio files</span><b>0</b><Icon name="check" size={13}/></button></section>
            <section className={s.railCard}><div className={s.railHeading}><Icon name="activity"/><h2>Recent recordings</h2></div>{activities.slice(0, 3).map((activity, i) => <button key={i} className={s.recentItem} onClick={() => setEditing({ ...songs.find(song => song.id === activity.id)! })}><span className={s.activityDot}/><span><strong>{activity.name}</strong> {activity.action}<b>{activity.song}</b><small>{activity.time}</small></span></button>)}<button className={s.textLink} onClick={() => showLibrary('all')}>View recordings<Icon name="arrow" size={13}/></button></section>

          </aside>
        </div>

      </main>
    </div>
    <dialog ref={dialog} className={s.dialog} aria-labelledby="preview-editor-title" onCancel={closeDialog} onClick={event => { if (event.target === event.currentTarget) closeDialog(); }}>
      <form onSubmit={event => { event.preventDefault(); if (editing) { changeSongs(songs.map(song => song.id === editing.id ? editing : song), 'Saved.'); } else { const name = bulkCollection.trim(); if (!name) return; changeSongs(songs.map(song => selected.includes(song.id) ? { ...song, collection: name } : song), `Added ${selected.length} recordings to “${name}”.`); setSelected([]); } closeDialog(); }}>
        <div className={s.dialogHead}><span className={s.eyebrow}>{editing ? 'RECORDING DETAILS' : 'BULK EDIT'}</span><button type="button" onClick={closeDialog} aria-label="Close editor"><Icon name="close"/></button></div>
        <h2 id="preview-editor-title">{editing ? editing.name : 'Add to collection'}</h2><p className={s.dialogIntro}>{editing ? `${editing.versions} ${editing.versions === 1 ? 'version' : 'versions'}` : `${selected.length} recordings selected`}</p>
        {editing ? <><RecordingPlayer key={editing.playbackId} recordingId={editing.playbackId}/><label>Song title<input required value={editing.name} onChange={event => setEditing({ ...editing, name: event.target.value })}/></label><div className={s.formGrid}><label>Instrument<input value={editing.instrument} placeholder="e.g. E. Guitar" onChange={event => setEditing({ ...editing, instrument: event.target.value })}/></label><label>Vibe<input value={editing.vibe} placeholder="e.g. Ambient" onChange={event => setEditing({ ...editing, vibe: event.target.value })}/></label><label>Type<select value={editing.finish} onChange={event => setEditing({ ...editing, finish: event.target.value })}>{['Tracked', 'Recorder', 'Voice Memo'].map(type => <option key={type}>{type}</option>)}</select></label><label>Year<input value={editing.year} inputMode="numeric" pattern="[0-9]{4}" onChange={event => setEditing({ ...editing, year: event.target.value })}/></label></div><label>Collection<input list="preview-collections" value={editing.collection} onChange={event => setEditing({ ...editing, collection: event.target.value })}/></label><label>Notes<textarea rows={3} value={editing.notes} onChange={event => setEditing({ ...editing, notes: event.target.value })}/></label></> : <label>Collection<input required autoFocus list="preview-collections" value={bulkCollection} onChange={event => setBulkCollection(event.target.value)}/></label>}
        <datalist id="preview-collections">{collections.map(collection => <option key={collection} value={collection}/>)}</datalist><div className={s.dialogFooter}><span>Preview changes only</span><button type="button" className={s.secondary} onClick={closeDialog}>Cancel</button><button className={s.primary} type="submit">{editing ? 'Save changes' : 'Add to collection'}</button></div>
      </form>
    </dialog>
    {toast && <div className={s.toast} role="status"><Icon name="check"/><span>{toast}</span>{undo && <button onClick={() => { setSongs(undo); setUndo(null); setToast('Change undone.'); }}>Undo</button>}<button onClick={() => setToast('')} aria-label="Dismiss notification"><Icon name="close" size={15}/></button></div>}
  </div>;
}
