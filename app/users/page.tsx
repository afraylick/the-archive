'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

interface UserSummary {
  id: string;
  name: string;
  isAdmin: boolean;
  stats: {
    ratingCount: number;
    averageRating: number;
    likeCount: number;
    commentCount: number;
    collectionCount: number;
  };
  ratedSongs: { id: string; name: string; rating: number }[];
  likedSongs: { id: string; name: string }[];
  commentedSongs: { id: string; name: string }[];
}

const BUILT_IN_USER_IDS = new Set(['adam', 'maurer', 'wills', 'jordi', 'roland', 'bobs']);

export default function ManageUsersPage() {
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [expandedUsers, setExpandedUsers] = useState<Record<string, boolean>>({});
  const [newUserName, setNewUserName] = useState('');
  const [newUserPassword, setNewUserPassword] = useState('');
  const [status, setStatus] = useState('');
  const [addUserStatus, setAddUserStatus] = useState('');
  const [isAddingUser, setIsAddingUser] = useState(false);

  const fetchUsers = () => {
    fetch('/api/users')
      .then(res => res.json())
      .then((data: { users: UserSummary[] }) => setUsers(data.users || []));
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const updatePassword = async (userId: string) => {
    const passcode = passwords[userId]?.trim();
    if (!passcode) return;

    const res = await fetch('/api/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, passcode }),
    });

    const data = await res.json().catch(() => null) as { error?: string } | null;
    setStatus(res.ok ? 'Password updated' : data?.error || 'Password update failed');
    if (res.ok) {
      setPasswords(prev => ({ ...prev, [userId]: '' }));
    }
  };

  const addUser = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = newUserName.trim();
    const passcode = newUserPassword.trim();
    if (!name || !passcode) {
      setAddUserStatus('Name and password are required.');
      return;
    }

    setIsAddingUser(true);
    setAddUserStatus('Adding user...');

    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, passcode }),
      });
      const data = await res.json().catch(() => null) as { error?: string } | null;
      const message = res.ok ? 'User added.' : data?.error || 'User creation failed.';
      setStatus(message);
      setAddUserStatus(message);
      if (res.ok) {
        setNewUserName('');
        setNewUserPassword('');
        fetchUsers();
      }
    } catch {
      setStatus('User creation failed.');
      setAddUserStatus('User creation failed. Check your connection and try again.');
    } finally {
      setIsAddingUser(false);
    }
  };

  const deleteUser = async (user: UserSummary) => {
    if (user.id === 'adam') return;
    const confirmation = prompt(`Type ${user.name} to delete this user and remove their ratings, likes, and comments.`);
    if (confirmation !== user.name) return;

    const res = await fetch('/api/users', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: user.id }),
    });
    const data = await res.json().catch(() => null) as { error?: string } | null;
    setStatus(res.ok ? 'User deleted' : data?.error || 'User deletion failed');
    if (res.ok) {
      fetchUsers();
    }
  };

  const toggleUser = (userId: string) => {
    setExpandedUsers(prev => ({ ...prev, [userId]: !prev[userId] }));
  };

  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <div className="container mx-auto">
        <div className="mb-4 flex items-center gap-3">
          <Link href="/" className="rounded border border-border px-3 py-3 text-sm text-muted-foreground transition hover:text-foreground sm:py-2">
            Back
          </Link>
          <h1 className="text-3xl font-bold">Manage Users</h1>
          {status && <span className="text-sm text-muted-foreground">{status}</span>}
        </div>
        <form onSubmit={addUser} className="mb-4 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-col gap-2 md:flex-row md:items-end">
            <label className="min-w-0 flex-1 text-sm text-muted-foreground">
              New user
              <input
                type="text"
                value={newUserName}
                onChange={(event) => {
                  setNewUserName(event.target.value);
                  setAddUserStatus('');
                }}
                placeholder="Name"
                className="mt-1 w-full rounded border border-border bg-background p-3 text-foreground sm:p-2"
              />
            </label>
            <label className="min-w-0 flex-1 text-sm text-muted-foreground">
              Password
              <input
                type="password"
                value={newUserPassword}
                onChange={(event) => {
                  setNewUserPassword(event.target.value);
                  setAddUserStatus('');
                }}
                placeholder="Password"
                className="mt-1 w-full rounded border border-border bg-background p-3 text-foreground sm:p-2"
              />
              <span className="mt-1 block text-xs text-muted-foreground/80">8 characters minimum on the live site</span>
            </label>
            <button
              type="submit"
              disabled={isAddingUser || !newUserName.trim() || !newUserPassword.trim()}
              className="rounded bg-accent px-4 py-3 text-sm text-accent-foreground transition hover:bg-accent/80 disabled:opacity-50 md:py-2"
            >
              {isAddingUser ? 'Adding...' : 'Add User'}
            </button>
          </div>
          {addUserStatus && (
            <p className="mt-3 text-sm text-muted-foreground" role="status">
              {addUserStatus}
            </p>
          )}
        </form>
        <div className="space-y-4">
          {users.map(user => {
            const isExpanded = Boolean(expandedUsers[user.id]);

            return (
            <section key={user.id} className="rounded-lg border border-border bg-card p-4">
              <div className="mb-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <button
                  type="button"
                  onClick={() => toggleUser(user.id)}
                  className="min-w-0 text-left"
                  aria-expanded={isExpanded}
                >
                  <div className="flex items-center gap-2">
                    <span className="inline-flex h-9 w-9 items-center justify-center rounded border border-border bg-muted text-sm text-muted-foreground sm:h-6 sm:w-6">
                      {isExpanded ? '-' : '+'}
                    </span>
                    <h2 className="text-xl font-semibold">{user.name}</h2>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {user.stats.ratingCount} ratings · avg {user.stats.averageRating || 'N/A'} · {user.stats.likeCount} likes · {user.stats.commentCount} comments
                  </p>
                </button>
                <div className="flex min-w-0 max-w-md flex-1 flex-wrap justify-end gap-2 sm:flex-nowrap sm:gap-0">
                  <input
                    type="password"
                    value={passwords[user.id] || ''}
                    onChange={(event) => setPasswords(prev => ({ ...prev, [user.id]: event.target.value }))}
                    placeholder="New password"
                    className="min-w-0 flex-[1_1_12rem] rounded border border-border bg-background p-3 text-sm text-foreground sm:rounded-l sm:rounded-r-none sm:p-2"
                  />
                  <button
                    type="button"
                    onClick={() => updatePassword(user.id)}
                    className="rounded bg-accent px-3 py-3 text-sm text-accent-foreground transition hover:bg-accent/80 sm:rounded-l-none sm:rounded-r sm:py-2"
                  >
                    Save
                  </button>
                  {!BUILT_IN_USER_IDS.has(user.id) && (
                    <button
                      type="button"
                      onClick={() => deleteUser(user)}
                      className="rounded bg-red-600 px-3 py-3 text-sm text-white transition hover:bg-red-700 sm:ml-2 sm:py-2"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
              {isExpanded && <div className="grid gap-4 md:grid-cols-3">
                <div>
                  <h3 className="mb-2 text-sm font-medium text-foreground">Liked Songs</h3>
                  <div className="space-y-1 text-sm text-muted-foreground">
                    {user.likedSongs.length > 0 ? user.likedSongs.map(song => (
                      <Link key={song.id} href={`/?track=${encodeURIComponent(song.id)}`} className="block truncate hover:text-accent">
                        {song.name}
                      </Link>
                    )) : <p>None</p>}
                  </div>
                </div>
                <div>
                  <h3 className="mb-2 text-sm font-medium text-foreground">Ratings</h3>
                  <div className="space-y-1 text-sm text-muted-foreground">
                    {user.ratedSongs.length > 0 ? user.ratedSongs.map(song => (
                      <Link key={song.id} href={`/?track=${encodeURIComponent(song.id)}`} className="block truncate hover:text-accent">
                        {song.rating}/5 · {song.name}
                      </Link>
                    )) : <p>None</p>}
                  </div>
                </div>
                <div>
                  <h3 className="mb-2 text-sm font-medium text-foreground">Commented Songs</h3>
                  <div className="space-y-1 text-sm text-muted-foreground">
                    {user.commentedSongs.length > 0 ? user.commentedSongs.map(song => (
                      <Link key={song.id} href={`/?track=${encodeURIComponent(song.id)}`} className="block truncate hover:text-accent">
                        {song.name}
                      </Link>
                    )) : <p>None</p>}
                  </div>
                </div>
              </div>}
            </section>
            );
          })}
        </div>
      </div>
    </main>
  );
}
