'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';

export default function LoginPage() {
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [archiveName, setArchiveName] = useState('the archive');
  const [useLegacyLogo, setUseLegacyLogo] = useState(false);

  useEffect(() => {
    fetch('/api/session')
      .then(res => res.json())
      .then((data: { settings?: { archiveName?: string; legacyDefaults?: boolean } }) => {
        setArchiveName(data.settings?.archiveName || 'the archive');
        setUseLegacyLogo(Boolean(data.settings?.legacyDefaults));
      });
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');

    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode }),
    });

    if (res.ok) {
      const requestedNextUrl = new URLSearchParams(window.location.search).get('next') || '/';
      const nextUrl = requestedNextUrl.startsWith('/') && !requestedNextUrl.startsWith('//')
        ? requestedNextUrl
        : '/';
      window.location.href = nextUrl;
      return;
    }

    const data = await res.json().catch(() => null);
    setError(data?.error || 'Login failed');
    setSubmitting(false);
  };

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-4 text-foreground">
      <div className="pointer-events-none absolute inset-0 opacity-80" aria-hidden="true">
        <div className="login-wave-static" />
        <div className="login-wave login-wave-one" />
        <div className="login-wave login-wave-two" />
        <div className="login-wave login-wave-three" />
        <div className="login-wave login-wave-four" />
      </div>
      <form onSubmit={handleSubmit} className="relative z-10 w-full max-w-sm rounded-lg border border-border bg-card/95 p-6 shadow-xl backdrop-blur">
        {useLegacyLogo ? (
          <Image
            src="/adams_archive_waveform_logo_transparent.png"
            alt={archiveName}
            width={2048}
            height={683}
            priority
            className="mx-auto mb-7 h-24 w-auto max-w-full object-contain"
          />
        ) : (
          <div className="mx-auto mb-7 flex h-24 items-center justify-center gap-3" aria-label={archiveName}>
            <svg className="h-10 w-20 text-accent drop-shadow-[0_0_10px_rgba(54,128,233,0.55)]" viewBox="0 0 120 44" aria-hidden="true">
              <path d="M4 22h11l5-9 6 18 7-28 8 38 8-26 6 11 5-16 5 30 8-36 7 27 6-14 5 5h24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" />
              <path d="M4 22h112" fill="none" stroke="rgba(255,255,255,0.8)" strokeLinecap="round" strokeWidth="2" />
            </svg>
            <span className="text-2xl font-light text-foreground">{archiveName}</span>
          </div>
        )}
        <label className="mb-4 block text-sm text-muted-foreground">
          Password
          <input
            type="password"
            value={passcode}
            onChange={(event) => setPasscode(event.target.value)}
            className="mt-1 w-full rounded border border-border bg-background p-2 text-foreground"
            autoFocus
          />
        </label>
        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={submitting || !passcode}
          className="w-full rounded bg-accent px-4 py-2 text-accent-foreground transition hover:bg-accent/80 disabled:opacity-50"
        >
          {submitting ? 'Signing in...' : 'Enter'}
        </button>
      </form>
    </main>
  );
}
