'use client';
import { useState, type FormEvent } from 'react';

export function ArchiveDelete({ archive, onDeleted, onBusyChange }: { archive: { id: string; name: string }; onDeleted: () => void; onBusyChange?: (busy: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function remove(event: FormEvent) {
    event.preventDefault(); setBusy(true); onBusyChange?.(true); setError('');
    try {
      const response = await fetch(`/api/archives/${encodeURIComponent(archive.id)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmation }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Archive deletion failed');
      onDeleted();
    } catch (error) { setError(error instanceof Error ? error.message : 'Archive deletion failed'); }
    finally { setBusy(false); onBusyChange?.(false); }
  }
  return <div className="archive-delete">
    {!open ? <button type="button" onClick={() => setOpen(true)}>Delete archive…</button> : <form onSubmit={remove}>
      <strong>Delete {archive.name} permanently?</strong>
      <p>This removes all recordings and versions, including trash, stems, this archive’s collections, and its archive-only accounts. Its songs are removed from mixed collections. Your site account and other archives stay intact. There is no restore or site-maintained backup.</p>
      <label><span>Type <b>{archive.name}</b> to confirm</span><input required autoComplete="off" spellCheck={false} aria-label={`Confirm deletion of ${archive.name}`} value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)}/></label>
      {error && <p role="alert">{error}</p>}
      <div className="archive-dialog-actions"><button type="button" disabled={busy} onClick={() => { setOpen(false); setConfirmation(''); setError(''); }}>Cancel deletion</button><button disabled={busy || confirmation !== archive.name}>{busy ? 'Deleting…' : 'Delete archive permanently'}</button></div>
    </form>}
  </div>;
}
