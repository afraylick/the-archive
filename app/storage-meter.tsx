'use client';
import { useEffect, useState } from 'react';
interface StorageUsage { usedBytes: number; limitBytes: number; trashBytes: number }
export function StorageMeter() {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    const load = () => fetch('/api/storage').then(async response => { if (!response.ok) throw new Error('Storage unavailable'); return response.json(); })
      .then(data => { if (active) { setUsage(data); setError(false); } }).catch(() => { if (active) setError(true); });
    void load(); window.addEventListener('storage-changed', load); window.addEventListener('focus', load);
    return () => { active = false; window.removeEventListener('storage-changed', load); window.removeEventListener('focus', load); };
  }, []);
  if (error) return <p className="storage-meter" role="status">Your storage usage is unavailable.</p>;
  if (!usage) return <p className="storage-meter" role="status">Loading your storage…</p>;
  const percent = Math.min(100, usage.usedBytes / usage.limitBytes * 100);
  return <div className="storage-meter"><div><strong>Your uploads</strong><span>{(usage.usedBytes / (1024 ** 3)).toFixed(2)} of 5 GB used</span></div><progress aria-label="Your upload storage" value={usage.usedBytes} max={Math.max(usage.usedBytes, usage.limitBytes)}/><small>{percent >= 100 ? 'Upload limit reached. Permanently delete items from trash to free space.' : 'Audio, versions, stems, and trash count toward your limit.'}</small></div>;
}
