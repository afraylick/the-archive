'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { archiveUrl } from '@/lib/recording-url';
import s from './management.module.css';
import { useRouter } from 'next/navigation';
import { ArchiveDelete } from '../archive-delete';
import type { PersonalArchive } from '@/lib/archives';
import type { ArchiveUser } from '@/lib/auth';
import { ARCHIVE_PALETTES, archivePaletteStyle, type ArchivePaletteId } from '@/lib/archive-palettes';
async function request(url: string, method = 'GET', body?: unknown) {
  const response = await fetch(url, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Request failed'); return data;
}
interface TrashItem { id: string; name: string; trashedAt: string; recordingCount: number }
export function TrashPanel({ onChange }: { onChange: () => void }) {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState('');
  const [canPurge, setCanPurge] = useState(false);
  const [purgeId, setPurgeId] = useState(''); const [purgeText, setPurgeText] = useState('');
  const load = useCallback(async () => { const data = await request(archiveUrl('/api/trash')); setItems(data.trash); setCanPurge(data.canPurge); }, []);
  // load waits for network responses before updating component state.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load().catch(error => setError(error.message)); }, [load]);
  async function act(item: TrashItem, purge: boolean) {
    if (purge && purgeText !== 'DELETE') return;
    setBusy(item.id); setError(''); setNotice('');
    try {
      const data = await request(`/api/trash/${encodeURIComponent(item.id)}`, purge ? 'DELETE' : 'POST', purge ? { confirmation: 'DELETE' } : undefined);
      setNotice(data.message); setPurgeId(''); setPurgeText(''); await load(); onChange(); window.dispatchEvent(new Event('storage-changed'));
    } catch (error) { setError(error instanceof Error ? error.message : 'Trash update failed'); }
    finally { setBusy(''); }
  }
  return <div className="archive-tools"><p className={s.sectionHint}>Trashed recordings stay here until you restore or permanently delete them. They use storage and are removed from all collections. Restoring a song does not re-add it to collections.</p>
    {error && <p role="alert" className={s.dialogError}>{error} <button onClick={() => void load().then(() => setError('')).catch(error => setError(error.message))}>Retry</button></p>}
    {notice && <p role="status">{notice}</p>}
    {items === null && !error && <p role="status">Loading trash…</p>}
    {items?.length === 0 && <p className={s.sectionHint}>Trash is empty.</p>}
    {items?.map(item => <div className="archive-tool-row" key={item.id}><div><strong>{item.name}</strong><small>{new Date(item.trashedAt).toLocaleString()} · {item.recordingCount} recording{item.recordingCount === 1 ? '' : 's'}</small></div><div className="archive-tool-actions"><button className={s.secondary} disabled={Boolean(busy)} onClick={() => void act(item, false)}>{busy === item.id ? 'Working…' : 'Restore'}</button>{canPurge && <button className="archive-danger" disabled={Boolean(busy)} onClick={() => { setPurgeId(item.id); setPurgeText(''); }}>Delete permanently</button>}</div>{purgeId === item.id && <form className="archive-purge-confirm" onSubmit={event => { event.preventDefault(); void act(item, true); }}><p>Delete “{item.name}” and its trashed versions permanently? This cannot be undone.</p><label>Type DELETE to confirm<input autoFocus required autoComplete="off" value={purgeText} onChange={event => setPurgeText(event.target.value)}/></label><button type="button" className={s.secondary} disabled={Boolean(busy)} onClick={() => setPurgeId('')}>Cancel</button><button className="archive-danger" disabled={Boolean(busy) || purgeText !== 'DELETE'}>Delete permanently</button></form>}</div>)}
  </div>;
}
interface ScopedAccount { id: string; name: string; hasAccess: boolean }
export function ArchiveSettingsPanel({ archive, people, palette, onPaletteChange }: { archive: PersonalArchive; people: ArchiveUser[]; palette: ArchivePaletteId; onPaletteChange: (palette: ArchivePaletteId) => void }) {
  const router = useRouter();
  const [name, setName] = useState(archive.name);
  const [members, setMembers] = useState(archive.memberIds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      await request('/api/archives', 'PATCH', { id: archive.id, name, memberIds: members, palette });
      setNotice('Archive settings saved.'); router.refresh();
    } catch (error) { setError(error instanceof Error ? error.message : 'Archive update failed'); }
    finally { setBusy(false); }
  }
  return <div className="archive-tools archive-settings">
    {!archive.deletingAt ? <form onSubmit={save} className="archive-settings-form">
      <p className={s.sectionHint}>You are the Archive Admin. Set your archive’s name and choose who can browse it. Your access is always retained.</p>
      <label>Archive name<input required maxLength={80} value={name} disabled={busy} onChange={event => setName(event.target.value)}/></label>
      <fieldset disabled={busy}><legend>Who can browse this archive?</legend><p>Leave everyone unchecked to keep it private.</p>
        <div className="archive-member-list">{people.filter(person => person.id !== archive.ownerId && (!person.archiveScopeId || person.archiveScopeId === archive.id)).map(person => <label key={person.id}><input type="checkbox" checked={members.includes(person.id)} onChange={event => setMembers(previous => event.target.checked ? [...previous, person.id] : previous.filter(id => id !== person.id))}/>{person.name}</label>)}</div>
      </fieldset>
      <p className={s.sectionHint}>Songs shared in collections stay available there after archive access is removed. Remove them from those collections to end that access too.</p>
      <fieldset disabled={busy}><legend>Color palette</legend><p>Preview a complete palette for backgrounds, panes, text, and accents. Save to apply it for everyone in this archive.</p>
        <div className="archive-palette-grid">{ARCHIVE_PALETTES.map(option => <label className="archive-palette-choice" key={option.id} style={archivePaletteStyle(option.id)}>
          <input type="radio" name="archive-palette" value={option.id} checked={palette === option.id} onChange={() => onPaletteChange(option.id)}/>
          <span className="archive-palette-sample" aria-hidden="true"><i/><span/><b/></span>
          <span>{option.name}{option.id === 'blue' ? <small>Default</small> : null}</span>
        </label>)}</div>
      </fieldset>
      {error && <p role="alert" className={s.dialogError}>{error}</p>}{notice && <p role="status">{notice}</p>}
      <button className={s.primary} disabled={busy}>{busy ? 'Saving…' : 'Save archive settings'}</button>
    </form> : <p role="status" className={s.sectionHint}>Archive deletion is unfinished. Retry below to finish cleanup.</p>}
    <ArchiveDelete key={archive.name} archive={archive} onBusyChange={setBusy} onDeleted={() => {
      localStorage.removeItem('songie-archive');
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign('/');
    }}/>
  </div>;
}
export function ArchiveAccountsPanel({ archiveId }: { archiveId: string }) {
  const [users, setUsers] = useState<ScopedAccount[]>([]);
  const [limit, setLimit] = useState(10); const [loaded, setLoaded] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [name, setName] = useState(''); const [password, setPassword] = useState(''); const [busy, setBusy] = useState('');
  const [resetId, setResetId] = useState(''); const [resetPassword, setResetPassword] = useState('');
  const load = useCallback(async () => {
    const accounts = await request(`/api/archives/${encodeURIComponent(archiveId)}/users`);
    setUsers(accounts.users); setLimit(accounts.limit); setLoaded(true);
  }, [archiveId]);
  // load waits for network responses before updating component state.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load().catch(error => setError(error.message)); }, [load]);
  async function create(event: FormEvent) {
    event.preventDefault(); setBusy('create'); setError(''); setNotice('');
    try { await request(`/api/archives/${encodeURIComponent(archiveId)}/users`, 'POST', { name, passcode: password }); setName(''); setPassword(''); await load(); setNotice('Archive-only account created. Share its password with that person directly.'); }
    catch (error) { setError(error instanceof Error ? error.message : 'Account creation failed'); } finally { setBusy(''); }
  }
  async function reset(event: FormEvent) {
    event.preventDefault(); setBusy(resetId); setError('');
    try { await request(`/api/archives/${encodeURIComponent(archiveId)}/users`, 'PATCH', { userId: resetId, passcode: resetPassword }); setResetId(''); setResetPassword(''); setNotice('Password updated. Previous sessions are signed out.'); }
    catch (error) { setError(error instanceof Error ? error.message : 'Password update failed'); } finally { setBusy(''); }
  }
  async function remove(account: ScopedAccount) {
    if (!window.confirm(`Remove the archive-only account “${account.name}”? Their recordings and comments will remain.`)) return;
    setBusy(account.id); setError('');
    try { await request(`/api/archives/${encodeURIComponent(archiveId)}/users`, 'DELETE', { userId: account.id }); await load(); setNotice('Archive-only account removed.'); }
    catch (error) { setError(error instanceof Error ? error.message : 'Account removal failed'); } finally { setBusy(''); }
  }
  return <div className="archive-tools"><p className={s.sectionHint}>Create accounts that can use only this archive and its collections. They can listen, comment, rate, and upload versions. They cannot create archives or manage site accounts.</p>
    {error && <p role="alert" className={s.dialogError}>{error}</p>}{notice && <p role="status">{notice}</p>}
    {loaded && <><p className={s.sectionHint}><strong>{users.length} of {limit} accounts</strong> · Your account and invitations to existing site users do not count. The site Owner sets this limit.</p>
      <form onSubmit={create} className="archive-account-form"><label>Name<input required maxLength={80} autoComplete="off" value={name} onChange={e => setName(e.target.value)}/></label><label>Initial password<input required minLength={8} maxLength={1024} type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)}/></label><button className={s.primary} disabled={Boolean(busy) || users.length >= limit}>{busy === 'create' ? 'Creating…' : 'Create account'}</button></form>
      {users.length >= limit && <p className={s.sectionHint}>Account limit reached. Remove an unused archive-only account or ask the site Owner to raise your limit.</p>}
      {users.map(user => <div className="archive-tool-row" key={user.id}><div><strong>{user.name}</strong><small>{user.hasAccess ? 'Archive-only member' : 'Archive access removed'}</small></div><div className="archive-tool-actions"><button className={s.secondary} disabled={Boolean(busy)} onClick={() => { setResetId(user.id); setResetPassword(''); }}>Reset password</button><button className="archive-danger" disabled={Boolean(busy)} onClick={() => void remove(user)}>Remove account</button></div></div>)}
      {resetId && <form onSubmit={reset} className="archive-account-form"><label>New password for {users.find(u => u.id === resetId)?.name}<input required autoFocus type="password" minLength={8} maxLength={1024} autoComplete="new-password" value={resetPassword} onChange={e => setResetPassword(e.target.value)}/></label><button className={s.primary} disabled={Boolean(busy)}>Save password</button><button type="button" className={s.secondary} disabled={Boolean(busy)} onClick={() => setResetId('')}>Cancel</button></form>}
    </>}
  </div>;
}
