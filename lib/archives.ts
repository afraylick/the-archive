import fs from 'fs';
import path from 'path';
import { getStorageRoot } from './storage';
import { writeJsonAtomic } from './json-storage';
import { getArchiveSettings } from './archive-settings';
import { getPublicUsers, type ArchiveUser } from './auth';
import { getArchiveIndex } from './archive-index';
import { isArchivePalette, type ArchivePaletteId } from './archive-palettes';

export const DEFAULT_ARCHIVE_ACCOUNT_LIMIT = 10;
export const MAX_ARCHIVE_ACCOUNT_LIMIT = 100;
export interface PersonalArchive { palette?: ArchivePaletteId; accountLimit?: number; id: string; name: string; ownerId: string; memberIds: string[]; createdAt: string; deletingAt?: string }
export interface ArchiveRecording { id: string; archiveId?: string; projectId?: string; uploadedBy?: string }
const registryCache = globalThis as typeof globalThis & { songieArchiveRegistry?: { file: string; signature: string; archives: PersonalArchive[] } };
const store = () => path.join(getStorageRoot(), 'archives.json');
export function readArchives(): PersonalArchive[] {
  if (fs.existsSync(store())) {
    const file = store();
    const stat = fs.statSync(file);
    const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (registryCache.songieArchiveRegistry?.file === file && registryCache.songieArchiveRegistry.signature === signature) return structuredClone(registryCache.songieArchiveRegistry.archives);
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(value) && value.some(archive => archive?.palette !== undefined && !isArchivePalette(archive.palette))) throw new Error('Archive palette storage is unreadable');
    if (!Array.isArray(value) || value.some(a => !a || typeof a.id !== 'string' || typeof a.name !== 'string' || typeof a.ownerId !== 'string' || !Array.isArray(a.memberIds) || a.memberIds.some((id: unknown) => typeof id !== 'string') || (a.deletingAt !== undefined && typeof a.deletingAt !== 'string') || (a.accountLimit !== undefined && (!Number.isInteger(a.accountLimit) || a.accountLimit < 0 || a.accountLimit > MAX_ARCHIVE_ACCOUNT_LIMIT)))) throw new Error('Archive storage is unreadable');
    registryCache.songieArchiveRegistry = { file, signature, archives: value };
    return structuredClone(value);
  }
  // Snapshot existing membership once. New accounts receive no implicit access.
  const archives = [{ id: 'adam', ownerId: 'adam', name: getArchiveSettings().archiveName, memberIds: getPublicUsers().filter(u => u.id !== 'adam').map(u => u.id), createdAt: new Date(0).toISOString() }];
  writeJsonAtomic(store(), archives);
  return archives;
}
export const canAccessArchive = (archive: PersonalArchive, user: Pick<ArchiveUser, 'id' | 'archiveScopeId'>) => !archive.deletingAt && (!user.archiveScopeId || user.archiveScopeId === archive.id) && (archive.ownerId === user.id || archive.memberIds.includes(user.id));
export const canManageArchive = (archive: PersonalArchive, user: Pick<ArchiveUser, 'id' | 'isAdmin'>) => !archive.deletingAt && (archive.ownerId === user.id || (archive.id === 'adam' && user.isAdmin));
export const canDeleteArchive = (archive: PersonalArchive, user: Pick<ArchiveUser, 'id' | 'role' | 'archiveScopeId'>) => !user.archiveScopeId && (user.role === 'owner' || archive.ownerId === user.id);
export function recordingArchiveId(record: ArchiveRecording): string {
  if (record.archiveId) return record.archiveId;
  if (record.projectId) return (getArchiveIndex().byId.get(record.projectId)?.archiveId as string) || 'adam';
  return 'adam';
}
export const archiveForRecording = (record: ArchiveRecording, archives = readArchives()) => archives.find(a => a.id === recordingArchiveId(record));
export function canReadRecording(record: ArchiveRecording, user: ArchiveUser, archives = readArchives()) {
  const archive = archiveForRecording(record, archives);
  return Boolean(archive && canAccessArchive(archive, user));
}
export function canEditRecording(record: ArchiveRecording, user: ArchiveUser, archives = readArchives()) {
  const archive = archiveForRecording(record, archives);
  return Boolean(archive && canAccessArchive(archive, user) && (canManageArchive(archive, user) || record.uploadedBy === user.id));
}
export function selectedArchive(user: ArchiveUser, requested?: string | null) {
  const available = readArchives().filter(a => canAccessArchive(a, user));
  return requested ? available.find(a => a.id === requested) : available.find(a => a.ownerId === user.id) || available[0];
}
