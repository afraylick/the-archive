'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ArchivePaletteId } from '@/lib/archive-palettes';
import type { Collection } from '@/lib/collections';
import s from './collections.module.css';

export interface CollectionView extends Collection { palette?: ArchivePaletteId; songIds: string[]; canEdit: boolean; canManage: boolean }
interface Person { id: string; name: string }
const jsonRequest = async (url: string, method = 'GET', body?: unknown) => {
  const response = await fetch(url, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Please try again');
  return data;
};

export function CollectionsPanel({ collections, selectedId, loading, error }: { collections: CollectionView[]; selectedId?: string; loading: boolean; error: string }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState('private');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  return <details className={s.panel}>
    <summary><span aria-hidden="true">♫</span><span>Collections</span><small>{collections.length}</small><span className={s.chevron} aria-hidden="true">⌄</span></summary>
    <nav aria-label="Collections" className={s.collectionList}>
      {selectedId && <Link href="/" className={s.libraryLink}>← All songs</Link>}
      {loading && <p className={s.hint}>Loading collections…</p>}
      {error && <p className={s.error} role="alert">{error}</p>}
      {!loading && !error && !collections.length && <p className={s.hint}>Make a playlist for your next idea.</p>}
      {collections.map(collection => <Link key={collection.id} href={`/collections/${encodeURIComponent(collection.id)}`} aria-current={selectedId === collection.id ? 'page' : undefined} className={s.collectionLink}>
        <span><strong>{collection.name}</strong><small>{collection.visibility === 'private' ? 'Private' : 'Public'} · {collection.songIds.length} song{collection.songIds.length === 1 ? '' : 's'}</small></span><span aria-hidden="true">›</span>
      </Link>)}
    </nav>
    <div className={s.newCollection}>
      <button type="button" onClick={() => setCreating(!creating)} aria-expanded={creating} className={s.textButton}>{creating ? 'Cancel' : '+ New collection'}</button>
      {creating && <form className={s.createForm} onSubmit={async event => {
        event.preventDefault(); setBusy(true); setFailure('');
        try { const data = await jsonRequest('/api/collections', 'POST', { name, visibility }); router.push(`/collections/${data.collection.id}`); }
        catch (error) { setFailure((error as Error).message); }
        finally { setBusy(false); }
      }}>
        <label>Name<input required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="Collection name" autoFocus/></label>
        <label>Visibility<select value={visibility} onChange={event => setVisibility(event.target.value)}><option value="public">Public</option><option value="private">Private</option></select></label>
        <p className={s.hint}>{visibility === 'public' ? 'Every account on this site can listen and comment, including people without source archive access.' : 'Only you and the people you invite can open it.'}</p>
        <button className={s.primary} disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create collection'}</button>
        {failure && <p role="alert" className={s.error}>{failure}</p>}
      </form>}
    </div>
  </details>;
}

export function CollectionHeader({ id, user, people, value, onChange }: { id: string; user: Person | null; people: Person[]; value: CollectionView | null; onChange: (collection: CollectionView) => void }) {
  const router = useRouter();
  const collection = value;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(false);
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('private');
  const [members, setMembers] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [picker, setPicker] = useState(false);
  const [songs, setSongs] = useState<{ id: string; name: string }[] | null>(null);
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const wasAtBottom = useRef(true);
  const accept = useCallback((next: CollectionView) => { onChange(next); }, [onChange]);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try { const data = await jsonRequest(`/api/collections/${encodeURIComponent(id)}`); if (active) { accept(data.collection); setError(''); } }
      catch (error) { if (active) { setError((error as Error).message); } }
    };
    void load();
    const interval = window.setInterval(load, 15000);
    window.addEventListener('focus', load);
    return () => { active = false; window.clearInterval(interval); window.removeEventListener('focus', load); };
  }, [id, accept]);
  useEffect(() => {
    if (wasAtBottom.current && chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [collection?.comments.length]);
  const act = async (path: string, method: string, body?: unknown) => {
    setBusy(true); setError('');
    try {
      const data = await jsonRequest(`/api/collections/${encodeURIComponent(id)}${path}`, method, body);
      if (data.collection) accept(data.collection);
      if (data.comments && collection) accept({ ...collection, comments: data.comments });
      return true;
    } catch (error) { setError((error as Error).message); return false; }
    finally { setBusy(false); }
  };
  if (!collection) return <section className={s.header}><Link href="/" className={s.textButton}>← All songs</Link><p role={error ? 'alert' : 'status'} className={error ? s.error : s.hint}>{error || 'Loading collection…'}</p></section>;
  const owner = people.find(person => person.id === collection.ownerId)?.name || 'Collection owner';
  return <section className={s.header}>
    <Link href="/" className={s.textButton}>← All songs</Link>
    <div className={s.titleRow}><div><div className={s.eyebrow}>COLLECTION <span>{collection.visibility}</span></div><h1>{collection.name}</h1><p className={s.hint}>By {owner} · {collection.songIds.length} song{collection.songIds.length === 1 ? '' : 's'}{collection.visibility === 'private' ? ' · Everyone here can see everyone’s ratings' : ''}</p></div>
      <div className={s.actions}>
        <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(window.location.href); setCopied(true); window.setTimeout(() => setCopied(false), 2000); } catch { setError('Could not copy the link. You can copy it from the address bar.'); } }}>{copied ? 'Link copied' : 'Copy link'}</button>
        {collection.canEdit && <button className={s.primary} type="button" aria-expanded={picker} onClick={async () => {
          setPicker(!picker);
          if (!songs) try { const files = await jsonRequest('/api/files?view=metadata&scope=accessible'); setSongs(files.flatMap((file: { id: string; name: string; archiveName?: string; uploads?: { id: string; name: string }[] }) => [{ ...file, name: `${file.archiveName || 'Archive'} / ${file.name}` }, ...(file.uploads || []).map(upload => ({ ...upload, name: `${file.name} / ${upload.name}` }))])); } catch (error) { setError((error as Error).message); }
        }}>{picker ? 'Done' : '+ Add songs'}</button>}
        {collection.canManage && <button type="button" aria-expanded={settings} onClick={() => { setName(collection.name); setVisibility(collection.visibility); setMembers(collection.memberIds); setSettings(!settings); }}>Sharing & settings</button>}
      </div>
    </div>
    {settings && <form className={s.settings} onSubmit={async event => { event.preventDefault(); if (await act('', 'PATCH', { name, visibility, memberIds: members })) setSettings(false); }}>
      <div className={s.settingsFields}><label>Name<input required maxLength={80} value={name} onChange={event => setName(event.target.value)}/></label><label>Visibility<select value={visibility} onChange={event => setVisibility(event.target.value as 'public' | 'private')}><option value="public">Public</option><option value="private">Private</option></select></label></div>
      <p className={s.hint}>{visibility === 'private' ? 'Only you and invited members can see this collection and its chat.' : 'Every account on this site can open this collection. Invite people to help with the playlist.'}</p>
      <fieldset><legend>Invite people</legend><div className={s.members}>{people.filter(person => person.id !== collection.ownerId).map(person => <label key={person.id}><input type="checkbox" checked={members.includes(person.id)} onChange={event => setMembers(event.target.checked ? [...members, person.id] : members.filter(member => member !== person.id))}/>{person.name}</label>)}</div><p className={s.hint}>Invited members can add, remove, and reorder songs.</p></fieldset>
      <div className={s.actions}><button className={s.primary} disabled={busy}>Save changes</button><button type="button" onClick={() => setSettings(false)}>Cancel</button><button className={s.danger} type="button" disabled={busy} onClick={async () => { if (window.confirm(`Delete “${collection.name}” and its chat? Songs stay in the library.`) && await act('', 'DELETE')) router.push('/'); }}>Delete collection</button></div>
    </form>}
    {picker && <div className={s.picker}><p className={s.hint}>Songs from every archive you can browse. Adding a song gives collection listeners access to that recording and its notes, comments, and attachments.</p><label>Find songs<input aria-label="Find songs to add" placeholder="Search the library…" value={query} onChange={event => setQuery(event.target.value)}/></label><div className={s.songChoices}>{songs === null ? <p className={s.hint}>Loading songs…</p> : songs.filter(song => song.name.toLowerCase().includes(query.trim().toLowerCase())).map(song => <div key={song.id}><span>{song.name}</span><button type="button" disabled={busy || collection.songIds.includes(song.id)} onClick={() => void act('', 'PATCH', { addSongId: song.id })}>{collection.songIds.includes(song.id) ? 'Added' : '+ Add'}</button></div>)}</div>{songs && !songs.some(song => song.name.toLowerCase().includes(query.trim().toLowerCase())) && <p className={s.hint}>No songs match your search.</p>}</div>}
    <div className={s.chat}>
      <div className={s.chatHeading}><h2>Conversation</h2><span>{collection.comments.length} message{collection.comments.length === 1 ? '' : 's'}</span></div>
      <div ref={chatRef} className={s.messages} role="log" aria-label="Collection conversation" onScroll={event => { const node = event.currentTarget; wasAtBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60; }}>
        {!collection.comments.length && <p className={s.emptyChat}>What should we work on next? Start the conversation.</p>}
        {collection.comments.map(comment => <article key={comment.id} className={s.message}><div className={s.avatar} aria-hidden="true">{(people.find(person => person.id === comment.userId)?.name || comment.userName).slice(0, 1)}</div><div className={s.messageBody}><div className={s.messageMeta}><strong>{people.find(person => person.id === comment.userId)?.name || comment.userName}</strong><time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>{(user?.id === comment.userId || collection.canManage) && <button disabled={busy} type="button" aria-label={`Delete message by ${comment.userName}`} onClick={() => void act('/comments', 'DELETE', { commentId: comment.id })}>Delete</button>}</div><p>{comment.text}</p></div></article>)}
      </div>
      <form className={s.composer} onSubmit={async event => { event.preventDefault(); wasAtBottom.current = true; if (await act('/comments', 'POST', { text })) setText(''); }}><textarea required maxLength={4000} aria-label="Message the collection" placeholder="Leave a thought, share an idea…" value={text} onChange={event => setText(event.target.value)} rows={2}/><button className={s.primary} disabled={busy || !text.trim()}>Send</button></form>
    </div>
    {error && <p role="alert" className={s.error}>{error}</p>}
  </section>;
}

export function PlaylistControls({ collection, songIds, onChange }: { collection: CollectionView; songIds: string[]; onChange: (collection: CollectionView) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!collection.canEdit) return null;
  const memberIds = songIds.filter(id => collection.songIds.includes(id));
  return <div className={s.playlistControls}>{memberIds.map((id, index) => <div key={id}><span>{memberIds.length > 1 ? `Version ${index + 1}` : `#${collection.songIds.indexOf(id) + 1}`}</span>{(['up', 'down', 'remove'] as const).map(action => <button key={action} type="button" aria-label={action === 'remove' ? 'Remove song from collection' : `Move song ${action}`} disabled={busy || (action === 'up' && collection.songIds.indexOf(id) === 0) || (action === 'down' && collection.songIds.indexOf(id) === collection.songIds.length - 1)} onClick={async () => {
    setBusy(true); setError('');
    try { const data = await jsonRequest(`/api/collections/${encodeURIComponent(collection.id)}`, 'PATCH', action === 'remove' ? { removeSongId: id } : { moveSongId: id, direction: action }); onChange(data.collection); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }}>{action === 'remove' ? 'Remove' : action === 'up' ? '↑' : '↓'}</button>)}</div>)}{error && <p role="alert" className={s.error}>{error}</p>}</div>;
}
