'use client';

import type { ArchivePaletteId } from '@/lib/archive-palettes';
import { useEffect, useRef, useState, type FormEvent } from 'react';

export interface ArchiveChoice { palette?: ArchivePaletteId; id: string; name: string; ownerId: string; memberIds: string[]; canManage: boolean }
interface Person { id: string; name: string; archiveScopeId?: string }
export function ArchiveSwitcher({ userId, people, onResolve, canCreate = true }: { canCreate?: boolean; userId?: string; people: Person[]; onResolve: (archive: ArchiveChoice | null) => void }) {
  const [archives, setArchives] = useState<ArchiveChoice[]>([]);
  const [current, setCurrent] = useState<ArchiveChoice | null>(null);
  const [pendingDeletions, setPendingDeletions] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    fetch('/api/archives', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Archives could not be loaded');
      return response.json() as Promise<{ archives: ArchiveChoice[]; pendingDeletions?: { id: string; name: string }[] }>;
    }).then(data => {
      if (controller.signal.aborted) return;
      const requested = new URLSearchParams(window.location.search).get('archive') || localStorage.getItem('songie-archive');
      const archive = data.archives.find(a => a.id === requested) || data.archives.find(a => a.ownerId === userId) || data.archives[0] || null;
      setArchives(data.archives); setPendingDeletions(data.pendingDeletions || []); setCurrent(archive); onResolve(archive);
      if (archive) localStorage.setItem('songie-archive', archive.id);
      else localStorage.removeItem('songie-archive');
      setLoading(false);
    }).catch(error => { if (!controller.signal.aborted) { setError(error.message); setLoading(false); } });
    return () => controller.abort();
  }, [userId, onResolve]);
  useEffect(() => { if (editing) dialog.current?.showModal(); else dialog.current?.close(); }, [editing]);

  function choose(archive: ArchiveChoice) {
    localStorage.setItem('songie-archive', archive.id);
    // Reset archive-specific players and filters together.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(`/?archive=${encodeURIComponent(archive.id)}`);
  }
  function open() {
    if (menu.current) menu.current.open = false;
    setError(''); setName(`${people.find(p => p.id === userId)?.name || 'My'}'s Archive`);
    setMembers([]);
    setEditing(true);
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError('');
    try {
      const response = await fetch('/api/archives', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, memberIds: members }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Archive could not be saved');
      choose(result.archive);
    } catch (error) { setError(error instanceof Error ? error.message : 'Archive could not be saved'); setSaving(false); }
  }
  const title = current?.name || (loading ? 'Loading archive…' : 'Your archives');
  const parts = title.trim().split(/\s+/); const accent = parts.pop();
  const ownsArchive = archives.some(a => a.ownerId === userId);
  return <>
    <details ref={menu} className="archive-switcher" onKeyDown={event => { if (event.key === 'Escape' && menu.current) menu.current.open = false; }}>
      <summary aria-label={`Select archive: ${title}`} className="text-2xl font-light tracking-normal"><span>{parts.join(' ')} </span><span className="text-accent">{accent}</span><span className="archive-chevron" aria-hidden="true">⌄</span></summary>
      <div className="archive-menu">
        <p className="archive-menu-label">Your archives</p>
        {archives.map(a => <button key={a.id} onClick={() => choose(a)} aria-current={current?.id === a.id ? 'true' : undefined}><span>{a.name}</span><small>{a.ownerId === userId ? 'Archive Admin' : 'Shared with you'}{current?.id === a.id ? ' · ✓' : ''}</small></button>)}
        {canCreate && !ownsArchive && !pendingDeletions.length && !loading && <button onClick={open}>+ Create your archive<small>Private until you invite someone</small></button>}
        {error && !editing && <p role="alert">{error} <button onClick={() => window.location.reload()}>Retry</button></p>}
      </div>
    </details>
    <dialog ref={dialog} className="archive-dialog" onCancel={event => { if (saving) event.preventDefault(); else setEditing(false); }} onClose={() => setEditing(false)}>
      <form onSubmit={save}>
        <h2>Create your archive</h2>
        <p>You are the Archive Admin. Your uploads stay in your archive. Invited people can listen, comment, rate, and add versions. You control tags and recording details.</p>
        <label>Archive name<input autoFocus required maxLength={80} disabled={saving} value={name} onChange={e => setName(e.target.value)}/></label>
        <fieldset disabled={saving}><legend>Who can browse this archive?</legend><p>You always have access. Leave everyone unchecked to keep it private.</p>
          <div className="archive-member-list">{people.filter(person => person.id !== userId && !person.archiveScopeId).map(person => <label key={person.id}><input type="checkbox" checked={members.includes(person.id)} onChange={event => setMembers(previous => event.target.checked ? [...previous, person.id] : previous.filter(id => id !== person.id))}/>{person.name}</label>)}</div>
        </fieldset>
        <p>You can change access later in Manage → Archive Settings.</p>
        {error && <p role="alert" className="text-red-300">{error}</p>}
        <div className="archive-dialog-actions"><button type="button" disabled={saving} onClick={() => setEditing(false)}>Cancel</button><button className="archive-save" disabled={saving}>{saving ? 'Creating…' : 'Create archive'}</button></div>
      </form>
    </dialog>
  </>;
}
