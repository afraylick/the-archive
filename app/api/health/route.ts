import fs from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { getStorageRoot } from '@/lib/storage';
import { getArchiveIndex } from '@/lib/archive-index';

export async function GET(req: NextRequest) {
  if (!getSessionUser(req)?.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  try {
    const disk = await fs.promises.statfs(getStorageRoot());
    const memory = process.memoryUsage();
    const state = globalThis as typeof globalThis & { archiveUploadsActive?: number; archiveTranscodes?: Map<string, Promise<void>> };
    return NextResponse.json({ status: 'ok', recordings: getArchiveIndex().byId.size, uptimeSeconds: Math.floor(process.uptime()),
      memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed }, freeDiskBytes: disk.bavail * disk.bsize,
      activeUploads: state.archiveUploadsActive || 0, pendingTranscodes: state.archiveTranscodes?.size || 0,
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch {
    return NextResponse.json({ status: 'error', error: 'Storage unavailable or invalid' }, { status: 503 });
  }
}
