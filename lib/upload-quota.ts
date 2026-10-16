import fs from 'fs';
import { getArchiveIndex } from './archive-index';
import { archiveForRecording, readArchives } from './archives';
import { getStemPath, getStorageRoot, getUploadPath, isSafeStorageId } from './storage';
import { UploadError } from './stream-upload';
import { getUserById } from './auth';

export const USER_UPLOAD_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
interface Usage { usedBytes: number; trashBytes: number }
interface Reservation { userId: string; root: string; bytes: number; credit: number; replacement?: string }
const state = globalThis as typeof globalThis & {
  songieQuotaReservations?: Set<Reservation>;
  songieQuotaUsage?: Map<string, { signature: string; usage: Usage }>;
};
state.songieQuotaReservations ??= new Set();
state.songieQuotaUsage ??= new Map();
const fileSize = (file: string) => {
  try { return fs.statSync(file).size; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
};
/** Charge uploaded source bytes and ZIPs to their uploader, including trash; exclude generated caches. */
export function userStorageUsage(userId: string, fresh = false): Usage {
  const index = getArchiveIndex();
  const key = `${getStorageRoot()}:${userId}`;
  const cached = state.songieQuotaUsage!.get(key);
  if (!fresh && cached?.signature === index.signature) return cached.usage;
  const archives = readArchives();
  let usedBytes = 0; let trashBytes = 0;
  const seen = new Set<string>();
  for (const record of index.allMetadata) {
    const ownerId = (record.uploadedBy as string | undefined) || archiveForRecording(record, archives)?.ownerId || 'adam';
    const stems = record.stems as { id: string; uploadedBy?: string } | undefined;
    const files = [[record.id, ownerId, getUploadPath], ...(stems ? [[stems.id, stems.uploadedBy || ownerId, getStemPath] as const] : [])] as const;
    for (const [id, uploaderId, pathFor] of files) {
      if (uploaderId !== userId || typeof id !== 'string' || !isSafeStorageId(id)) continue;
      const file = (pathFor as (id: string) => string)(id);
      if (seen.has(file)) continue;
      seen.add(file);
      const bytes = fileSize(file); usedBytes += bytes;
      if (record.trashedAt) trashBytes += bytes;
    }
  }
  const usage = { usedBytes, trashBytes };
  // Only cache the current data signature per account/storage root.
  state.songieQuotaUsage!.set(key, { signature: index.signature, usage });
  return usage;
}
function reservedFor(userId: string, root: string) {
  return [...state.songieQuotaReservations!].filter(r => r.userId === userId && r.root === root).reduce((bytes, r) => bytes + Math.max(0, r.bytes - r.credit), 0);
}
export function uploadStorageSummary(userId: string) {
  const usage = userStorageUsage(userId, true);
  const reservedBytes = reservedFor(userId, getStorageRoot());
  const unlimited = getUserById(userId)?.role === 'owner';
  return { ...usage, unlimited, limitBytes: unlimited ? null : USER_UPLOAD_QUOTA_BYTES, reservedBytes, remainingBytes: unlimited ? null : Math.max(0, USER_UPLOAD_QUOTA_BYTES - usage.usedBytes - reservedBytes) };
}
/** Reservations are charged while streaming, shared across requests, and released on every exit. */
export function reserveUploadQuota(userId: string, replacement?: { key: string; credit: number }) {
  const root = getStorageRoot();
  if (replacement && [...state.songieQuotaReservations!].some(r => r.root === root && r.replacement === replacement.key)) throw new UploadError('This attachment is already being replaced. Try again shortly.', 409);
  userStorageUsage(userId, true);
  const reservation: Reservation = { root, userId, bytes: 0, credit: replacement?.credit || 0, replacement: replacement?.key };
  state.songieQuotaReservations!.add(reservation);
  let released = false;
  const assertCapacity = () => {
    if (released) throw new UploadError('Upload reservation expired', 409);
    if (getUserById(userId)?.role !== 'owner' && userStorageUsage(userId).usedBytes + reservedFor(userId, root) > USER_UPLOAD_QUOTA_BYTES) throw new UploadError('Your 5 GB upload limit is reached. Permanently delete items from trash to free space.', 413);
  };
  return {
    addBytes(bytes: number) { reservation.bytes += bytes; assertCapacity(); },
    assertCapacity,
    release() { released = true; state.songieQuotaReservations!.delete(reservation); },
  };
}
export function stemReplacementCredit(recordId: string, userId: string) {
  const record = getArchiveIndex().byId.get(recordId);
  const stems = record?.stems as { id: string; uploadedBy?: string } | undefined;
  const ownerId = record && ((record.uploadedBy as string | undefined) || archiveForRecording(record)?.ownerId || 'adam');
  return { stemId: stems?.id, key: `stems:${recordId}`, credit: stems && (stems.uploadedBy || ownerId) === userId && isSafeStorageId(stems.id) ? fileSize(getStemPath(stems.id)) : 0 };
}
