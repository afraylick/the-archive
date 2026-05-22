'use client';

import Image from 'next/image';
import { useState } from 'react';

export default function LoginPage() {
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

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
        <Image
          src="/adams_archive_waveform_logo_transparent.png"
          alt="the archive"
          width={2048}
          height={683}
          priority
          className="mx-auto mb-7 h-24 w-auto max-w-full object-contain"
        />
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
