'use client';
import { ArchiveLimits } from './archive-limits';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../manage/manage-icon';
import { roleLabel, type UserRole } from '@/lib/roles';
import s from '../manage/management.module.css';
import u from './users.module.css';

interface UserSummary {
  id: string;
  name: string;
  isAdmin: boolean;
  role: UserRole;
  isArchiveAdmin?: boolean;
  lastLoginAt?: string | null;
  permissions: { canEdit: boolean; canChangeRole: boolean; canDelete: boolean };
  stats: { ratingCount: number; averageRating: number; likeCount: number; commentCount: number; collectionCount: number };
  ratedSongs: { id: string; name: string; rating: number }[];
  likedSongs: { id: string; name: string }[];
  commentedSongs: { id: string; name: string }[];
}

type Activity = 'Ratings' | 'Likes' | 'Comments';
const initials = (name: string) => name.split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase();
const interactions = (user: UserSummary) => user.stats.ratingCount + user.stats.likeCount + user.stats.commentCount;

function LastLogin({ value }: { value?: string | null }) {
  if (!value || !Number.isFinite(Date.parse(value))) return <span className={u.noLogin}>Not recorded</span>;
  const date = new Date(value);
  return <time className={u.lastLogin} dateTime={value} title={date.toLocaleString(undefined, { timeZoneName: 'long' })}>
    <span>{date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
    <small>{date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}</small>
  </time>;
}

async function request<T>(method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/users', { method, signal, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || 'Member request failed.');
  return data as T;
}

export default function ManageUsersPage() {
  const router = useRouter();
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState('');
  const [session, setSession] = useState<{ id: string; name: string } | null>(null);
  const [archiveName, setArchiveName] = useState('the archive');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('name');
  const [password, setPassword] = useState('');
  const [roleDraft, setRoleDraft] = useState<'admin' | 'member' | ''>('');
  const [activity, setActivity] = useState<Activity>('Ratings');
  const [allActivity, setAllActivity] = useState(false);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [modal, setModal] = useState<'add' | 'delete' | null>(null);
  const [newName, setNewName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [dialogError, setDialogError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const details = useRef<HTMLElement>(null);

  const load = useCallback((signal?: AbortSignal) => {
    return request<{ users: UserSummary[] }>('GET', undefined, signal).then(data => {
      if (signal?.aborted) return;
      setUsers(data.users);
      setNames(Object.fromEntries(data.users.map(user => [user.id, user.name])));
      setLoadError('');
    }).catch(error => {
      if (!signal?.aborted) setLoadError(error instanceof Error ? error.message : 'Members unavailable.');
    }).finally(() => { if (!signal?.aborted) setLoading(false); });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    void fetch('/api/session', { signal: controller.signal }).then(response => response.ok ? response.json() : null).then(data => {
      if (data && !controller.signal.aborted) { setSession(data.user); if (data.settings?.archiveName) setArchiveName(data.settings.archiveName); }
    }).catch(() => {});
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (modal && !dialog.current?.open) dialog.current?.showModal();
    if (!modal && dialog.current?.open) dialog.current.close();
  }, [modal]);

  const selected = users.find(user => user.id === selectedId) || users[0];
  const admins = users.filter(user => user.role === 'admin').length;
  const owners = users.filter(user => user.role === 'owner').length;
  const contributors = users.filter(user => interactions(user) > 0).length;
  const totals = users.reduce((total, user) => ({ ratings: total.ratings + user.stats.ratingCount, likes: total.likes + user.stats.likeCount, comments: total.comments + user.stats.commentCount }), { ratings: 0, likes: 0, comments: 0 });
  const visible = users.filter(user => (filter === 'all' || (['admins', 'owners', 'members'].includes(filter) ? user.role === ({ admins: 'admin', owners: 'owner', members: 'member' } as Record<string, UserRole>)[filter] : interactions(user) > 0)) && user.name.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => {
    const difference = sort === 'activity' ? interactions(b) - interactions(a) : sort === 'login' ? (Date.parse(b.lastLoginAt || '') || 0) - (Date.parse(a.lastLoginAt || '') || 0) : 0;
    return difference || a.name.localeCompare(b.name);
  });
  const activityItems = selected ? activity === 'Ratings' ? selected.ratedSongs : activity === 'Likes' ? selected.likedSongs : selected.commentedSongs : [];
  const brand = archiveName.split(' ');
  const brandAccent = brand.pop();

  function selectMember(user: UserSummary) {
    setSelectedId(user.id); setPassword(''); setRoleDraft(''); setAllActivity(false); setNotice(null);
    if (window.matchMedia('(max-width:1000px)').matches) requestAnimationFrame(() => details.current?.scrollIntoView({ block: 'start', behavior: 'instant' }));
  }
  function openModal(kind: 'add' | 'delete') { setDialogError(''); setNewName(''); setNewPassword(''); setConfirmation(''); setModal(kind); }

  async function saveName(user: UserSummary) {
    if (busy || !user.permissions.canEdit || !names[user.id]?.trim()) return;
    setBusy('name'); setNotice(null);
    try {
      const data = await request<{ user: { name: string } }>('PATCH', { userId: user.id, name: names[user.id].trim() });
      setUsers(previous => previous.map(item => item.id === user.id ? { ...item, name: data.user.name } : item));
      setNames(previous => ({ ...previous, [user.id]: data.user.name }));
      if (session?.id === user.id) setSession({ ...session, name: data.user.name });
      setNotice({ text: 'Member name saved.' });
    } catch (error) { setNotice({ text: error instanceof Error ? error.message : 'Name update failed.', error: true }); }
    finally { setBusy(''); }
  }

  async function savePassword(user: UserSummary) {
    if (busy || !user.permissions.canEdit || !password.trim()) return;
    setBusy('password'); setNotice(null);
    try {
      await request('PATCH', { userId: user.id, passcode: password.trim() });
      setPassword(''); setNotice({ text: 'Password updated.' });
      if (session?.id === user.id) router.replace('/login');
    } catch (error) { setNotice({ text: error instanceof Error ? error.message : 'Password update failed.', error: true }); }
    finally { setBusy(''); }
  }

  async function saveRole(user: UserSummary) {
    if (busy || !user.permissions.canChangeRole || !roleDraft || roleDraft === user.role) return;
    setBusy('role'); setNotice(null);
    try {
      const data = await request<{ user: { role: UserRole; isAdmin: boolean } }>('PATCH', { userId: user.id, role: roleDraft });
      setUsers(previous => previous.map(item => item.id === user.id ? { ...item, ...data.user } : item));
      setRoleDraft(''); setNotice({ text: `${user.name}: ${roleLabel(data.user.role)} access saved.` });
    } catch (error) { setNotice({ text: error instanceof Error ? error.message : 'Role update failed.', error: true }); }
    finally { setBusy(''); }
  }

  async function submitDialog(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !modal || (modal === 'delete' && (!selected || confirmation !== selected.name))) return;
    setBusy(modal); setDialogError('');
    try {
      if (modal === 'add') {
        const data = await request<{ user: Pick<UserSummary, 'id' | 'name' | 'isAdmin' | 'role' | 'permissions'> }>('POST', { name: newName.trim(), passcode: newPassword.trim() });
        const user: UserSummary = { ...data.user, stats: { ratingCount: 0, averageRating: 0, likeCount: 0, commentCount: 0, collectionCount: 0 }, ratedSongs: [], likedSongs: [], commentedSongs: [] };
        setUsers(previous => [...previous, user]); setNames(previous => ({ ...previous, [user.id]: user.name }));
        selectMember(user); setQuery(''); setFilter('all'); setNotice({ text: 'Member added.' });
      } else if (selected) {
        await request('DELETE', { userId: selected.id });
        setUsers(previous => previous.filter(user => user.id !== selected.id)); setSelectedId(''); setPassword('');
        setNotice({ text: 'Member deleted.' });
      }
      setNewPassword(''); setModal(null);
    } catch (error) { setDialogError(error instanceof Error ? error.message : 'Request failed.'); }
    finally { setBusy(''); }
  }

  return <div className={`archive-shell ${s.shell}`}>
    <header className={s.header}>
      <Link href="/" className={s.back}><Icon name="back" size={15}/> Back to archive</Link>
      <Link href="/" className={s.brand} aria-label="Archive homepage"><svg viewBox="0 0 120 44" aria-hidden="true"><path d="M4 22h11l5-9 6 18 7-28 8 38 8-26 6 11 5-16 5 30 8-36 7 27 6-14 5 5h24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 22h112" stroke="#dce7f3" strokeWidth="2"/></svg><span>{brand.join(' ')}{brand.length ? ' ' : ''}<em>{brandAccent}</em></span></Link>
      <div className={s.headerActions}>{session && <span className={s.avatar} title={session.name}>{initials(session.name)}</span>}</div>
    </header>
    <div className={s.layout}>
      <aside className={s.sidebar}>
        <div className={s.sideLabel}>WORKSPACE</div>
        <nav aria-label="Management sections">
          <Link href="/manage" className={s.navItem}><Icon name="library"/><span>Management</span><Icon name="arrow" size={13}/></Link>
          <Link href="/upload" className={s.navItem}><Icon name="plus"/><span>Upload recordings</span></Link>
        </nav>
        <div className={s.sideLabel}>ADMINISTRATION</div>
        <nav aria-label="Administration"><Link href="/users" className={`${s.navItem} ${s.navActive}`} aria-current="page"><Icon name="users"/><span>Members & access</span>{!loading && !loadError && <small>{users.length}</small>}</Link></nav>
      </aside>
      <main className={s.main}>
        <div className={s.heading}><h1>Members & access</h1><button className={s.primary} disabled={loading || !!loadError || !!busy} onClick={() => openModal('add')}><Icon name="plus" size={17}/> Add member</button></div>
        <ArchiveLimits/>
        {loading ? <p className={u.state} role="status">Loading members…</p> : loadError ? <div className={u.state} role="alert"><p>{loadError}</p><button className={s.secondary} onClick={() => { setLoading(true); void load(); }}>Retry</button></div> : <>
          <div className={s.stats}>{[
            { label: 'Total members', value: users.length, icon: 'users', filter: 'all' },
            { label: 'Site administrators', value: admins, icon: 'shield', filter: 'admins' },
            { label: 'Contributors', value: contributors, icon: 'activity', filter: 'contributors' },
            { label: 'Ratings', value: totals.ratings, icon: 'music', filter: 'all' },
          ].map(stat => <button key={stat.label} className={s.stat} onClick={() => setFilter(stat.filter)}><div><span>{stat.label}</span><Icon name={stat.icon}/></div><strong>{String(stat.value).padStart(2, '0')}</strong></button>)}</div>
          <div className={u.workspace}>
            <section className={s.content} aria-label="Member directory">
              <div className={s.sectionHead}><h2>Members</h2><span className={u.count}>{users.length} accounts</span></div>
              <div className={`${s.tabs} ${u.memberTabs}`} aria-label="Member views">{[['all', 'All members', users.length], ['owners', 'Owner', owners], ['admins', 'Site Admins', admins], ['members', 'Members', users.length - admins - owners]].map(([value, label, count]) => <button key={value} className={filter === value ? s.tabActive : ''} onClick={() => setFilter(String(value))}>{label}<span>{count}</span></button>)}{filter === 'contributors' && <button className={s.tabActive} onClick={() => setFilter('all')}>Contributors <span>{contributors}</span><Icon name="close" size={12}/></button>}</div>
              <div className={s.toolbar}><label className={s.search}><Icon name="search" size={17}/><input aria-label="Search members" placeholder="Search members…" value={query} onChange={event => setQuery(event.target.value)}/>{query && <button aria-label="Clear search" onClick={() => setQuery('')}><Icon name="close" size={14}/></button>}</label><select aria-label="Sort members" value={sort} onChange={event => setSort(event.target.value)}><option value="name">Name A–Z</option><option value="activity">Most activity</option><option value="login">Last login</option></select></div>
              <div className={s.tableScroll}><table className={u.table}><thead><tr><th>MEMBER</th><th>ACCESS</th><th>RATINGS</th><th>LIKES</th><th>COMMENTS</th><th>LAST LOGIN</th><th><span className={s.srOnly}>Details</span></th></tr></thead><tbody>{visible.map(user => <tr key={user.id} className={selected?.id === user.id ? u.selected : ''}>
                <td><button className={u.member} onClick={() => selectMember(user)} aria-label={`Manage ${user.name}`} aria-pressed={selected?.id === user.id}><span className={`${s.avatar} ${user.isAdmin ? u.adminAvatar : ''}`}>{initials(user.name)}</span><span><strong>{user.name}{session?.id === user.id && <small>You</small>}</strong><span>{roleLabel(user.role)}</span></span></button></td>
                <td><span className={`${u.badge} ${user.isAdmin ? u.adminBadge : ''}`}>{roleLabel(user.role)}</span>{user.isArchiveAdmin && <small className={u.badge}>Archive Admin</small>}</td>
                <td><span className={u.number}>{user.stats.ratingCount}</span><small className={u.average}>{user.stats.ratingCount ? `${user.stats.averageRating} avg` : '—'}</small></td><td className={u.number}>{user.stats.likeCount}</td><td className={u.number}>{user.stats.commentCount}</td><td><LastLogin value={user.lastLoginAt}/></td><td><button className={u.open} aria-label={`Open ${user.name} details`} onClick={() => selectMember(user)}><Icon name="arrow" size={15}/></button></td>
              </tr>)}</tbody></table></div>
              {visible.length === 0 && <div className={s.empty}><Icon name="users" size={26}/><h3>No members found</h3><button className={s.textLink} onClick={() => { setQuery(''); setFilter('all'); }}>Clear filters</button></div>}
              <div className={s.tableFooter}><span>{visible.length} of {users.length} members</span><span>{totals.likes} likes · {totals.comments} comments</span></div>
            </section>
            {selected && <aside ref={details} className={u.details} aria-label="Member details">
              <div className={u.detailHead}><span className={`${s.avatar} ${u.largeAvatar}`}>{initials(selected.name)}</span><div><span className={s.eyebrow}>MEMBER DETAILS</span><h2>{selected.name}</h2><span className={`${u.badge} ${selected.isAdmin ? u.adminBadge : ''}`}>{roleLabel(selected.role)}</span>{selected.isArchiveAdmin && <span className={u.badge}>Archive Admin</span>}</div></div>
              <div className={u.detailBody}>
                <dl className={u.loginSummary}><dt>Last login</dt><dd><LastLogin value={selected.lastLoginAt}/></dd></dl>
                <form className={u.editForm} onSubmit={event => { event.preventDefault(); void saveRole(selected); }}><label htmlFor="member-role">Access role</label>{selected.permissions.canChangeRole ? <div className={u.inputAction}><select id="member-role" value={roleDraft || selected.role} onChange={event => setRoleDraft(event.target.value as 'admin' | 'member')} disabled={!!busy}><option value="member">Member</option><option value="admin">Site Admin</option></select><button className={s.secondary} disabled={!!busy || !roleDraft || roleDraft === selected.role}>{busy === 'role' ? 'Saving…' : 'Save role'}</button></div> : <><span className={u.badge}>{roleLabel(selected.role)}</span><small>{selected.role === 'owner' ? 'Owner access is protected.' : 'Only the site Owner can change roles.'}</small></>}</form>
                <form className={u.editForm} onSubmit={event => { event.preventDefault(); void saveName(selected); }}><label htmlFor="member-name">Display name</label><div className={u.inputAction}><input id="member-name" value={names[selected.id] ?? selected.name} onChange={event => setNames(previous => ({ ...previous, [selected.id]: event.target.value }))} disabled={!!busy || !selected.permissions.canEdit}/><button className={s.secondary} disabled={!!busy || !selected.permissions.canEdit || !names[selected.id]?.trim() || names[selected.id]?.trim() === selected.name}>{busy === 'name' ? 'Saving…' : 'Save name'}</button></div></form>
                <form className={u.editForm} onSubmit={event => { event.preventDefault(); void savePassword(selected); }}><label htmlFor="member-password">Reset password</label><input id="member-password" type="password" autoComplete="new-password" placeholder="New password" value={password} onChange={event => setPassword(event.target.value)} disabled={!!busy || !selected.permissions.canEdit}/><div className={u.passwordAction}><small>8 characters minimum on the live site</small><button className={s.secondary} disabled={!!busy || !selected.permissions.canEdit || !password.trim()}>{busy === 'password' ? 'Saving…' : 'Save password'}</button></div>{session?.id === selected.id && <small>Changing your password signs you out.</small>}</form>
              </div>
              <div className={u.activityHead}><h3>Activity</h3><span>{interactions(selected)} interactions</span></div>
              <div className={`${s.tabs} ${u.activityTabs}`}>{(['Ratings', 'Likes', 'Comments'] as Activity[]).map(item => <button key={item} className={activity === item ? s.tabActive : ''} onClick={() => { setActivity(item); setAllActivity(false); }}>{item}<span>{item === 'Ratings' ? selected.stats.ratingCount : item === 'Likes' ? selected.stats.likeCount : selected.stats.commentCount}</span></button>)}</div>
              <div className={u.activityList}>{activityItems.length ? (allActivity ? activityItems : activityItems.slice(0, 6)).map(song => <Link key={song.id} href={`/?track=${encodeURIComponent(song.id)}`} className={u.track}><span className={u.trackIcon}><Icon name="music" size={15}/></span><span>{song.name}</span>{'rating' in song && <b>{String(song.rating)}<small> / 5</small></b>}<Icon name="arrow" size={12}/></Link>) : <p className={u.noActivity}>No {activity.toLowerCase()} yet.</p>}{activityItems.length > 6 && <button className={s.textLink} onClick={() => setAllActivity(!allActivity)}>{allActivity ? 'Show less' : `Show all ${activityItems.length}`}</button>}</div>
              {selected.permissions.canDelete && <div className={u.deleteArea}><button className={u.dangerLink} disabled={!!busy} onClick={() => openModal('delete')}>Delete member</button></div>}
            </aside>}
          </div>
        </>}
      </main>
    </div>
    <dialog ref={dialog} className={s.dialog} aria-labelledby="member-dialog-title" onCancel={event => { if (busy) event.preventDefault(); else setModal(null); }} onClose={() => { setModal(null); setNewPassword(''); }}>
      <form onSubmit={submitDialog}><div className={s.dialogHead}><span className={s.eyebrow}>{modal === 'add' ? 'MEMBERS & ACCESS' : 'REMOVE ACCESS'}</span><button type="button" disabled={!!busy} onClick={() => setModal(null)} aria-label="Close dialog"><Icon name="close"/></button></div><h2 id="member-dialog-title">{modal === 'add' ? 'Add member' : `Delete ${selected?.name}?`}</h2>
        {modal === 'add' ? <><div className={u.dialogFields}><label>Name<input autoComplete="off" required value={newName} onChange={event => setNewName(event.target.value)} disabled={!!busy}/></label><label>Password<input type="password" autoComplete="new-password" required value={newPassword} onChange={event => setNewPassword(event.target.value)} disabled={!!busy}/><small>8 characters minimum on the live site</small></label><span className={u.badge}>Member access</span></div></> : <><p className={u.deleteWarning}>This removes their account, ratings, likes, and comments.</p><label>Type {selected?.name} to confirm<input autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={!!busy}/></label></>}
        {dialogError && <p className={s.dialogError} role="alert">{dialogError}</p>}
        <div className={s.dialogFooter}><button className={s.secondary} type="button" disabled={!!busy} onClick={() => setModal(null)}>Cancel</button><button className={modal === 'delete' ? u.dangerButton : s.primary} disabled={!!busy || (modal === 'add' ? !newName.trim() || !newPassword.trim() : confirmation !== selected?.name)}>{busy === 'add' ? 'Adding…' : busy === 'delete' ? 'Deleting…' : modal === 'add' ? 'Add member' : 'Delete member'}</button></div>
      </form>
    </dialog>
    {notice && <div className={`${s.toast} ${notice.error ? u.errorToast : ''}`} role={notice.error ? 'alert' : 'status'}><Icon name={notice.error ? 'close' : 'check'} size={17}/>{notice.text}<button aria-label="Dismiss notification" onClick={() => setNotice(null)}><Icon name="close" size={14}/></button></div>}
  </div>;
}
