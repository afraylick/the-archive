'use client';
import { useEffect, useState } from 'react';
import { ArchiveDelete } from '../archive-delete';
interface ArchiveLimit { id: string; name: string; adminName: string; deletingAt?: string; accountLimit: number; accountCount: number }
export function ArchiveLimits() {
  const [limits, setLimits] = useState<ArchiveLimit[]>([]); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState('');
  useEffect(() => { fetch('/api/archives?view=limits').then(async response => { if (response.status === 403) return { archives: [] }; if (!response.ok) throw new Error('Account limits unavailable'); return response.json(); }).then(data => setLimits(data.archives)).catch(error => setError(error.message)); }, []);
  async function save(archive: ArchiveLimit) {
    setBusy(archive.id); setError(''); setNotice('');
    try { const response = await fetch('/api/archives', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: archive.id, accountLimit: archive.accountLimit }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); setNotice(`Limit saved for ${archive.name}.`); }
    catch (error) { setError(error instanceof Error ? error.message : 'Limit update failed'); } finally { setBusy(''); }
  }
  if (!limits.length && !error) return null;
  return <section className="archive-limit-settings"><h2>Site archives</h2><p>As site Owner, you can delete any archive and set its account limit. Archive Admins manage their own archives. Each archive can create up to 10 archive-only accounts by default. Set a limit from 0 to 100; lowering it keeps existing accounts.</p>{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}{limits.map(archive => <article key={archive.id}>
    <form className="archive-tool-row" onSubmit={event => { event.preventDefault(); void save(archive); }}><div><strong>{archive.name}</strong><small>Archive Admin: {archive.adminName} · {archive.accountCount} archive-only accounts</small>{archive.deletingAt && <small>Deletion unfinished. Retry below to finish cleanup.</small>}</div><label>Account limit<input type="number" min={0} max={100} required disabled={Boolean(archive.deletingAt)} aria-label={`Account limit for ${archive.name}`} value={Number.isNaN(archive.accountLimit) ? '' : archive.accountLimit} onChange={event => setLimits(old => old.map(a => a.id === archive.id ? { ...a, accountLimit: event.target.valueAsNumber } : a))}/></label><button disabled={Boolean(busy || archive.deletingAt)}>{busy === archive.id ? 'Saving…' : 'Save limit'}</button></form>
    <ArchiveDelete archive={archive} onDeleted={() => window.location.reload()}/>
  </article>)}</section>;
}
