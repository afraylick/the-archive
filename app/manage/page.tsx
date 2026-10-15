'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mutateRecording } from '@/lib/recording-mutations';
import {
  allManagedRecordings, defaultRecording, hasManagedWaveform,
  metadataEdits, projectInCollection, recordingTags, renameManagedCollection,
  replaceManagedRecording, type ManagedRecording,
} from '@/lib/management';
import AdvancedTools from './advanced-tools';
import type { CollectionView } from '../collections/collection-ui';
import Icon from './manage-icon';
import RecordingPlayer from './recording-player';
import s from './management.module.css';

type Section = 'Library' | 'Collections' | 'Activity' | 'Maintenance';
type Editor = { initial: ManagedRecording; name: string; instruments: string; vibes: string; finish: string; year: string; notes: string; collections: string[]; defaultVersionId: string };
const FINISH_OPTIONS = ['Tracked', 'Recorder', 'Voice Memo'];
const splitTags = (value: string) => Array.from(new Set(value.split(',').map(tag => tag.trim()).filter(Boolean)));
const formatDuration = (seconds?: number) => seconds ? `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}` : '—';
const formatDate = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';

async function requestJson<T>(url: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || 'Request failed.');
  return data as T;
}

export default function ManagePage() {
  const [collectionViews, setCollectionViews] = useState<CollectionView[]>([]);
  const [files, setFiles] = useState<ManagedRecording[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [archiveName, setArchiveName] = useState('the archive');
  const [initials, setInitials] = useState('');
  const [section, setSection] = useState<Section>('Library');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [collectionFilter, setCollectionFilter] = useState('');
  const [finish, setFinish] = useState('all');
  const [sort, setSort] = useState('recent');
  const [limit, setLimit] = useState(60);
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<Editor | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkCollection, setBulkCollection] = useState('');
  const [renaming, setRenaming] = useState<{ original: string; name: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch('/api/files?view=metadata', { signal });
    if (!response.ok) throw new Error('Library unavailable.');
    const data: ManagedRecording[] = await response.json();
    const catalog = await requestJson<{ collections: CollectionView[] }>('/api/collections', 'GET');
    if (!signal?.aborted) setCollectionViews(catalog.collections);
    if (!signal?.aborted) { setFiles(data); setLoadError(''); setLoading(false); }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // Refresh awaits network data before it updates React state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh(controller.signal).catch(() => { if (!controller.signal.aborted) { setLoadError('Library unavailable.'); setLoading(false); } });
    fetch('/api/session', { signal: controller.signal }).then(response => response.json()).then(data => {
      if (!controller.signal.aborted) {
        setArchiveName(data.settings?.archiveName || 'the archive');
        setInitials((data.user?.name || '').slice(0, 2).toUpperCase());
      }
    }).catch(() => {});
    return () => controller.abort();
  }, [refresh]);

  const modalOpen = Boolean(editing || bulkOpen || renaming);
  useEffect(() => { if (modalOpen) dialog.current?.showModal(); else dialog.current?.close(); }, [modalOpen]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(null), 6500); return () => clearTimeout(timer); }, [notice]);
  const paginationKey = JSON.stringify([query, filter, collectionFilter, finish, sort]);
  const [previousPaginationKey, setPreviousPaginationKey] = useState(paginationKey);
  if (previousPaginationKey !== paginationKey) { setPreviousPaginationKey(paginationKey); setLimit(60); }

  const allFiles = useMemo(() => allManagedRecordings(files), [files]);
  const collections = useMemo(() => collectionViews.map(collection => collection.name).sort((a, b) => a.localeCompare(b)), [collectionViews]);
  const missingTags = files.filter(file => !recordingTags(file, 'instruments').length || !recordingTags(file, 'vibes').length);
  const missingWaves = allFiles.filter(file => !hasManagedWaveform(file));
  const needsAttention = files.filter(file => missingTags.includes(file) || !hasManagedWaveform(defaultRecording(file)));
  const finishOptions = Array.from(new Set([...FINISH_OPTIONS, ...allFiles.map(file => file.finish || '').filter(Boolean)]));
  const visible = useMemo(() => files.filter(file => {
    const versions = [file, ...(file.uploads || [])];
    const search = query.trim().toLowerCase();
    return (!search || versions.some(recording => [recording.name, recording.originalName, recording.notes, ...(recording.collections || []), ...recordingTags(recording, 'instruments'), ...recordingTags(recording, 'vibes')].filter(Boolean).join(' ').toLowerCase().includes(search)))
      && (finish === 'all' || file.finish === finish)
      && (!collectionFilter || projectInCollection(file, collectionFilter))
      && (filter === 'all' || (filter === 'attention' && (!recordingTags(file, 'instruments').length || !recordingTags(file, 'vibes').length || !hasManagedWaveform(defaultRecording(file)))) || (filter === 'tags' && (!recordingTags(file, 'instruments').length || !recordingTags(file, 'vibes').length)) || (filter === 'waveforms' && !hasManagedWaveform(defaultRecording(file))) || (filter === 'stems' && file.stems));
  }).sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'versions' ? (b.uploads?.length || 0) - (a.uploads?.length || 0) : (Date.parse(b.uploadedAt || '') || 0) - (Date.parse(a.uploadedAt || '') || 0)), [files, query, finish, collectionFilter, filter, sort]);
  const recent = useMemo(() => [...allFiles].sort((a, b) => (Date.parse(b.uploadedAt || '') || 0) - (Date.parse(a.uploadedAt || '') || 0)).slice(0, 20), [allFiles]);
  const brand = archiveName.trim().split(/\s+/);
  const brandAccent = brand.pop();

  function notify(text: string, error = false) { setNotice({ text, error }); }
  function commit(id: string, changes: Partial<ManagedRecording>) { setFiles(current => replaceManagedRecording(current, id, changes)); }
  function showLibrary(nextFilter = 'all', collection = '') { setSection('Library'); setFilter(nextFilter); setCollectionFilter(collection); setFinish('all'); setQuery(''); }
  function closeDialog() { if (busy) return; setEditing(null); setBulkOpen(false); setRenaming(null); setDialogError(''); }
  function edit(file: ManagedRecording) {
    setDialogError('');
    setEditing({ initial: file, name: file.name, instruments: recordingTags(file, 'instruments').join(', '), vibes: recordingTags(file, 'vibes').join(', '), finish: file.finish || '', year: String(file.year || ''), notes: file.notes || '', collections: [...(file.collections || [])], defaultVersionId: defaultRecording(file).id });
  }

  async function changeType(file: ManagedRecording, value: string) {
    setBusy(file.id);
    try { commit(file.id, await mutateRecording<ManagedRecording>(file.id, { operation: 'metadata', changes: { finish: value } })); notify('Type saved.'); }
    catch (error) { notify(error instanceof Error ? error.message : 'Type update failed.', true); }
    finally { setBusy(''); }
  }

  async function saveEditor() {
    if (!editing) return;
    setBusy('editor'); setDialogError('');
    const draft = editing;
    let latest = draft.initial;
    try {
      const after = { ...draft.initial, name: draft.name.trim(), notes: draft.notes, finish: draft.finish, year: draft.year ? Number(draft.year) : undefined, instruments: splitTags(draft.instruments), vibes: splitTags(draft.vibes), ...(draft.defaultVersionId === defaultRecording(draft.initial).id ? {} : { defaultVersionId: draft.defaultVersionId }) };
      const changes = metadataEdits(draft.initial, after);
      if (Object.keys(changes).length) {
        const committed = await mutateRecording<ManagedRecording>(draft.initial.id, { operation: 'metadata', changes });
        commit(draft.initial.id, committed); latest = { ...latest, ...committed };
      }
      if (JSON.stringify(draft.collections) !== JSON.stringify(draft.initial.collections || [])) {
        const data = await requestJson<{ collections: string[] }>(`/api/files/${encodeURIComponent(draft.initial.id)}/collections`, 'PUT', { collections: draft.collections });
        commit(draft.initial.id, data); latest = { ...latest, ...data };
      }
      setEditing(null); notify('Saved.');
    } catch (error) {
      setEditing(current => current ? { ...current, initial: latest } : current);
      setDialogError(error instanceof Error ? error.message : 'Save failed.');
    } finally { setBusy(''); }
  }

  async function addToCollection() {
    const name = bulkCollection.trim();
    if (!name) return;
    setBusy('bulk'); setDialogError('');
    const failed: string[] = [];
    for (const id of selected) {
      const file = allFiles.find(recording => recording.id === id);
      if (!file) continue;
      try {
        const data = await requestJson<{ collections: string[] }>(`/api/files/${encodeURIComponent(id)}/collections`, 'PUT', { collections: Array.from(new Set([...(file.collections || []), name])) });
        commit(id, data);
      } catch { failed.push(id); }
    }
    setBusy(''); setSelected(failed);
    if (failed.length) setDialogError(`${failed.length} recording(s) could not be updated. Retry to finish.`);
    else { setBulkOpen(false); setBulkCollection(''); notify('Collection updated.'); void refresh().catch(() => notify('Refresh failed.', true)); }
  }

  async function renameCollection() {
    if (!renaming || !renaming.name.trim() || renaming.name.trim() === renaming.original) return;
    setBusy('rename'); setDialogError('');
    try {
      const data = await requestJson<{ collection: string; filesUpdated: number }>('/api/collections', 'PATCH', { collection: renaming.original, name: renaming.name.trim() });
      setFiles(current => renameManagedCollection(current, renaming.original, data.collection));
      setCollectionFilter(current => current === renaming.original ? data.collection : current);
      setRenaming(null); notify(`Collection renamed on ${data.filesUpdated} recording(s).`);
      void refresh().catch(() => notify('Refresh failed.', true));
    } catch (error) { setDialogError(error instanceof Error ? error.message : 'Rename failed.'); }
    finally { setBusy(''); }
  }

  async function rebuildWaveforms(targets: ManagedRecording[]) {
    setBusy('waveforms'); let failures = 0;
    for (const [index, file] of targets.entries()) {
      notify(`Rebuilding waveforms ${index + 1}/${targets.length}`);
      try {
        const data = await requestJson<{ waveformDuration: number; waveformCacheVersion: number }>(`/api/files/${encodeURIComponent(file.id)}/waveform`, 'POST');
        commit(file.id, { waveformAvailable: true, waveformDuration: data.waveformDuration, waveformCacheVersion: data.waveformCacheVersion });
      } catch { failures++; }
    }
    setBusy(''); notify(failures ? `${failures} waveform(s) could not be rebuilt.` : 'Waveforms rebuilt.', Boolean(failures));
  }

  function exportCsv() {
    const rows = [['Title', 'Original filename', 'Instruments', 'Vibes', 'Type', 'Year', 'Collections', 'Notes', 'ID'], ...visible.flatMap(project => [project, ...(project.uploads || [])]).map(file => [file.name, file.originalName || '', recordingTags(file, 'instruments').join('; '), recordingTags(file, 'vibes').join('; '), file.finish || '', file.year || '', (file.collections || []).join('; '), file.notes || '', file.id])];
    const url = URL.createObjectURL(new Blob([rows.map(row => row.map(cell => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `archive-export-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <div className={`archive-shell ${s.shell}`}>
    <header className={s.header}>
      <Link href="/" className={s.back}><Icon name="back" size={15}/> Back to archive</Link>
      <Link href="/" className={s.brand} aria-label="Archive homepage">
        <svg viewBox="0 0 120 44" aria-hidden="true"><path d="M4 22h11l5-9 6 18 7-28 8 38 8-26 6 11 5-16 5 30 8-36 7 27 6-14 5 5h24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 22h112" stroke="#dce7f3" strokeWidth="2"/></svg>
        <span>{brand.join(' ')}{brand.length ? ' ' : ''}<em>{brandAccent}</em></span>
      </Link>
      <div className={s.headerActions}>{initials && <span className={s.avatar}>{initials}</span>}</div>
    </header>
    <div className={s.layout}>
      <aside className={s.sidebar}>
        <div className={s.sideLabel}>WORKSPACE</div>
        <nav aria-label="Management sections">{(['Library', 'Collections', 'Activity', 'Maintenance'] as Section[]).map(item => <button key={item} className={`${s.navItem} ${section === item ? s.navActive : ''}`} onClick={() => { setSection(item); if (showAdvanced && item !== 'Maintenance') { setShowAdvanced(false); void refresh().catch(() => notify('Refresh failed.', true)); } }} aria-current={section === item ? 'page' : undefined}><Icon name={item.toLowerCase()}/><span>{item}</span>{item === 'Library' ? <small>{files.length}</small> : item === 'Maintenance' && needsAttention.length > 0 ? <span className={s.navDot}/> : null}</button>)}</nav>
        <div className={s.sideLabel}>ADMINISTRATION</div>
        <Link href="/users" className={s.navItem}><Icon name="users"/><span>Members & access</span><Icon name="arrow" size={13}/></Link>
        <button className={s.navItem} onClick={() => { setSection('Maintenance'); setShowAdvanced(true); }}><Icon name="shield"/><span>Advanced tools</span><Icon name="arrow" size={13}/></button>
      </aside>
      <main className={s.main}>
        <div className={s.heading}><h1>Management</h1><Link href="/upload" className={s.primary}><Icon name="plus"/> Upload recordings</Link></div>
        {loading && <p role="status">Loading recordings…</p>}
        {loadError && <p role="alert">{loadError} <button className={s.secondary} onClick={() => void refresh().catch(() => setLoadError('Library unavailable.'))}>Retry</button></p>}
        <div className={s.stats}>{[
          { label: 'Song projects', value: files.length, sub: `${allFiles.length} recordings across all versions`, icon: 'music', action: 'all' },
          { label: 'Collections', value: collections.length, icon: 'collections', action: 'collections' },
          { label: 'With stems', value: files.filter(file => file.stems).length, icon: 'library', action: 'stems' },
          { label: 'Needs attention', value: needsAttention.length, icon: 'maintenance', action: 'attention' },
        ].map(stat => <button key={stat.label} className={`${s.stat} ${stat.action === 'attention' ? s.attentionStat : ''}`} onClick={() => stat.action === 'collections' ? setSection('Collections') : showLibrary(stat.action)}><div><span>{stat.label}</span><Icon name={stat.icon}/></div><strong>{stat.value.toString().padStart(2, '0')}</strong>{stat.sub && <p>{stat.sub}</p>}</button>)}</div>
        <div className={`${s.contentGrid} ${section === 'Maintenance' && showAdvanced ? s.expanded : ''}`}>
          <section className={s.content} aria-label={section}>
            <div className={s.sectionHead}><h2>{section === 'Library' ? collectionFilter || 'Recordings' : section}</h2>{section === 'Library' && <button className={s.secondary} onClick={exportCsv}><Icon name="export" size={15}/>Export CSV</button>}</div>
            {section === 'Library' && <>
              <div className={s.tabs} role="group" aria-label="Library views">{[['all', 'All recordings', files.length], ['attention', 'Needs attention', needsAttention.length], ['stems', 'With stems', files.filter(file => file.stems).length]].map(([value, label, count]) => <button key={value} onClick={() => setFilter(String(value))} className={filter === value ? s.tabActive : ''}>{label}<span>{count}</span></button>)}</div>
              <div className={s.toolbar}>
                <label className={s.search}><Icon name="search" size={17}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search recordings, tags, notes…" aria-label="Search recordings"/>{query && <button onClick={() => setQuery('')} aria-label="Clear search"><Icon name="close" size={14}/></button>}</label>
                <select aria-label="Filter by recording type" value={finish} onChange={event => setFinish(event.target.value)}><option value="all">All types</option>{finishOptions.map(type => <option key={type}>{type}</option>)}</select>
                <select aria-label="Sort recordings" value={sort} onChange={event => setSort(event.target.value)}><option value="recent">Recently added</option><option value="name">Title A–Z</option><option value="versions">Most versions</option></select>
              </div>
              {collectionFilter && <div className={s.bulkBar}><span>Collection: {collectionFilter}</span><button onClick={() => setCollectionFilter('')}>Clear collection</button></div>}
              {selected.length > 0 && <div className={s.bulkBar}><span><strong>{selected.length}</strong> selected</span><button disabled={Boolean(busy)} onClick={() => { setDialogError(''); setBulkOpen(true); }}><Icon name="collections" size={15}/>Add to collection</button><button disabled={Boolean(busy)} onClick={() => void rebuildWaveforms(files.filter(file => selected.includes(file.id)).map(defaultRecording))}>Rebuild waveforms</button><button onClick={() => setSelected([])} aria-label="Clear selection"><Icon name="close" size={15}/></button></div>}
              <div className={s.tableScroll}><table className={s.table}>
                <thead><tr><th><input type="checkbox" aria-label="Select all visible recordings" checked={visible.length > 0 && visible.every(file => selected.includes(file.id))} onChange={event => setSelected(event.target.checked ? Array.from(new Set([...selected, ...visible.map(file => file.id)])) : selected.filter(id => !visible.some(file => file.id === id)))}/></th><th>RECORDING</th><th>TYPE / YEAR</th><th>DURATION</th><th>STATUS</th><th><span className={s.srOnly}>Edit</span></th></tr></thead>
                <tbody>{visible.slice(0, limit).map(file => <tr key={file.id} className={selected.includes(file.id) ? s.selectedRow : ''}>
                  <td><input type="checkbox" aria-label={`Select ${file.name}`} checked={selected.includes(file.id)} onChange={event => setSelected(current => event.target.checked ? [...current, file.id] : current.filter(id => id !== file.id))}/></td>
                  <td><button className={s.songTitle} onClick={() => edit(file)}>{file.name}</button><div className={s.songTags}>{[...recordingTags(file, 'instruments'), ...recordingTags(file, 'vibes')].slice(0, 3).map((tag, index) => <span key={`${tag}:${index}`}>{tag}</span>)}<small>{1 + (file.uploads?.length || 0)} {file.uploads?.length ? 'versions' : 'version'}</small></div></td>
                  <td><select className={s.inlineType} aria-label={`Type for ${file.name}`} value={file.finish || ''} disabled={Boolean(busy)} onChange={event => void changeType(file, event.target.value)}><option value="">Unspecified</option>{finishOptions.map(type => <option key={type}>{type}</option>)}</select><small className={s.year}>{file.year || '—'}</small></td>
                  <td><span className={s.type}>{formatDuration(defaultRecording(file).waveformDuration)}</span></td>
                  <td>{!hasManagedWaveform(defaultRecording(file)) ? <span className={s.warning}>Missing waveform</span> : missingTags.includes(file) ? <span className={s.warning}>Needs tags</span> : <span className={s.ready}><span/>Ready</span>}{file.stems && <small className={s.stems}>Stems attached</small>}</td>
                  <td><button className={s.editButton} aria-label={`Edit ${file.name}`} onClick={() => edit(file)}><Icon name="arrow" size={16}/></button></td>
                </tr>)}</tbody>
              </table></div>
              {!loading && !loadError && !visible.length && <div className={s.empty}><Icon name="search" size={28}/><h3>No recordings found</h3><button className={s.secondary} onClick={() => showLibrary()}>Clear filters</button></div>}
              <footer className={s.tableFooter}><span>Showing {Math.min(limit, visible.length)} of {visible.length} projects</span>{visible.length > limit && <button className={s.textLink} onClick={() => setLimit(value => value + 60)}>Load more</button>}</footer>
            </>}
            {section === 'Collections' && <div className={s.collectionGrid}>
              {collectionViews.map(collection => <article key={collection.id} className={s.collectionCard}>
                <div className={s.collectionArt}><Icon name="collections" size={28}/></div><h3>{collection.name}</h3><p>{collection.songIds.length} recordings · {collection.visibility}</p>
                <div className={s.collectionActions}><Link className={s.secondary} href={`/collections/${encodeURIComponent(collection.id)}`}>Open</Link>{collection.canManage && <button className={s.renameButton} aria-label={`Rename collection ${collection.name}`} disabled={Boolean(busy)} onClick={() => { setDialogError(''); setRenaming({ original: collection.name, name: collection.name }); }}>Rename</button>}</div>
              </article>)}
              {!collections.length && <p className={s.sectionHint}>No collections. Select recordings in Library to add one.</p>}
            </div>}
            {section === 'Activity' && <div className={s.activityList}>{recent.map(file => <div key={file.id} className={s.activity}><span className={s.avatar}><Icon name="music" size={14}/></span><div><p>Uploaded <button onClick={() => edit(file)}>{file.name}</button></p><small>{[file.uploadedByName, formatDate(file.uploadedAt)].filter(Boolean).join(' · ')}</small></div></div>)}</div>}
            {section === 'Maintenance' && <>
              <div className={s.maintenanceList}>
                <div className={s.maintenanceItem}><Icon name="activity" size={26}/><div><h3>Waveform cache</h3><p>{allFiles.length - missingWaves.length} of {allFiles.length} cached</p></div><button className={s.secondary} disabled={Boolean(busy) || !missingWaves.length} onClick={() => void rebuildWaveforms(missingWaves)}>Rebuild missing</button></div>
                <div className={s.maintenanceItem}><Icon name="export" size={26}/><div><h3>Metadata export</h3></div><button className={s.secondary} onClick={exportCsv}>Export CSV</button></div>
                <div className={s.maintenanceItem}><Icon name="shield" size={26}/><div><h3>Advanced tools</h3><p>Stems, variations, ratings, Finder tags, and deletion.</p></div><button className={s.secondary} disabled={Boolean(busy)} aria-expanded={showAdvanced} onClick={() => { setShowAdvanced(value => !value); if (showAdvanced) void refresh().catch(() => notify('Refresh failed.', true)); }}>{showAdvanced ? 'Hide tools' : 'Open tools'}</button></div>
              </div>
              {showAdvanced && <div className={s.advanced}><AdvancedTools/></div>}
            </>}
          </section>
          <aside className={s.rightRail}>
            <section className={s.health}><div className={s.railHeading}><Icon name="shield"/><h2>Archive health</h2><span className={s.liveDot}/></div><div className={s.healthNumber}>{Math.round(files.length ? (files.length - needsAttention.length) / files.length * 100 : 0)}<span>%</span><small>Complete</small></div><div className={s.progress}><span style={{ width: `${files.length ? (files.length - needsAttention.length) / files.length * 100 : 0}%` }}/></div><button onClick={() => showLibrary('tags')}><span className={s.amberDot}/><span>Missing tags</span><b>{missingTags.length}</b><Icon name="arrow" size={13}/></button><button onClick={() => showLibrary('waveforms')}><span className={s.amberDot}/><span>Projects missing waveforms</span><b>{files.filter(file => !hasManagedWaveform(defaultRecording(file))).length}</b><Icon name="arrow" size={13}/></button></section>
            <section className={s.railCard}><div className={s.railHeading}><Icon name="activity"/><h2>Recent recordings</h2></div>{recent.slice(0, 3).map(file => <button key={file.id} className={s.recentItem} onClick={() => edit(file)}><span className={s.activityDot}/><span><b>{file.name}</b><small>{formatDate(file.uploadedAt)}</small></span></button>)}<button className={s.textLink} onClick={() => setSection('Activity')}>View all<Icon name="arrow" size={13}/></button></section>
          </aside>
        </div>
      </main>
    </div>
    <dialog ref={dialog} className={s.dialog} aria-labelledby="management-dialog-title" onCancel={event => { event.preventDefault(); closeDialog(); }} onClick={event => { if (event.target === event.currentTarget) closeDialog(); }}>
      <form onSubmit={event => { event.preventDefault(); if (busy) return; if (editing) void saveEditor(); else if (renaming) void renameCollection(); else void addToCollection(); }}>
        <div className={s.dialogHead}><span className={s.eyebrow}>{editing ? 'RECORDING DETAILS' : renaming ? 'COLLECTION' : 'BULK EDIT'}</span><button type="button" disabled={Boolean(busy)} onClick={closeDialog} aria-label="Close editor"><Icon name="close"/></button></div>
        <h2 id="management-dialog-title">{editing ? editing.initial.name : renaming ? 'Rename collection' : 'Add to collection'}</h2>
        {dialogError && <p className={s.dialogError} role="alert">{dialogError}</p>}
        {editing ? <>
          <p className={s.dialogIntro}>{editing.initial.uploads?.length ? `${1 + editing.initial.uploads.length} versions` : '1 version'}</p>
          <RecordingPlayer key={editing.defaultVersionId} recordingId={editing.defaultVersionId}/>
          <label>Song title<input required maxLength={255} value={editing.name} onChange={event => setEditing({ ...editing, name: event.target.value })}/></label>
          <div className={s.formGrid}><label>Instruments<input value={editing.instruments} onChange={event => setEditing({ ...editing, instruments: event.target.value })}/></label><label>Vibes<input value={editing.vibes} onChange={event => setEditing({ ...editing, vibes: event.target.value })}/></label><label>Type<select value={editing.finish} onChange={event => setEditing({ ...editing, finish: event.target.value })}><option value="">Unspecified</option>{finishOptions.map(type => <option key={type}>{type}</option>)}</select></label><label>Year<input type="number" min="1900" max="2100" step="1" required={Boolean(editing.initial.year)} value={editing.year} onChange={event => setEditing({ ...editing, year: event.target.value })}/></label></div>
          {Boolean(editing.initial.uploads?.length) && <label>Default version<select value={editing.defaultVersionId} onChange={event => setEditing({ ...editing, defaultVersionId: event.target.value })}>{[editing.initial, ...(editing.initial.uploads || [])].map(version => <option key={version.id} value={version.id}>{version.name}{version.id === editing.initial.id ? ' (original)' : ''}</option>)}</select></label>}
          <fieldset className={s.collectionPicker}><legend>Collections</legend>{collections.map(collection => <label key={collection}><input type="checkbox" disabled={!collectionViews.some(item => item.name === collection && item.canEdit)} checked={editing.collections.includes(collection)} onChange={event => setEditing({ ...editing, collections: event.target.checked ? [...editing.collections, collection] : editing.collections.filter(value => value !== collection) })}/>{collection}</label>)}{!collections.length && <small>No collections.</small>}</fieldset>
          <label>Notes<textarea rows={3} maxLength={10000} value={editing.notes} onChange={event => setEditing({ ...editing, notes: event.target.value })}/></label>
        </> : renaming ? <>
          <p className={s.dialogIntro}>{files.filter(file => projectInCollection(file, renaming.original)).length} projects · all versions updated</p>
          <label>Collection name<input required autoFocus maxLength={80} value={renaming.name} onChange={event => setRenaming({ ...renaming, name: event.target.value })}/></label>
        </> : <>
          <p className={s.dialogIntro}>{selected.length} recordings selected</p><label>Collection<input required autoFocus maxLength={80} list="management-collections" value={bulkCollection} onChange={event => setBulkCollection(event.target.value)}/></label>
        </>}
        <datalist id="management-collections">{collectionViews.filter(collection => collection.canEdit).map(collection => <option key={collection.id} value={collection.name}/>)}</datalist>
        <div className={s.dialogFooter}><button type="button" className={s.secondary} disabled={Boolean(busy)} onClick={closeDialog}>Cancel</button><button type="submit" className={s.primary} disabled={Boolean(busy) || Boolean(renaming && (!renaming.name.trim() || renaming.name.trim() === renaming.original))}>{busy ? 'Saving…' : editing ? 'Save changes' : renaming ? 'Rename collection' : 'Add to collection'}</button></div>
      </form>
    </dialog>
    {notice && <div className={s.toast} role={notice.error ? 'alert' : 'status'}><Icon name={notice.error ? 'close' : 'check'}/><span>{notice.text}</span><button onClick={() => setNotice(null)} aria-label="Dismiss notification"><Icon name="close" size={15}/></button></div>}
  </div>;
}
