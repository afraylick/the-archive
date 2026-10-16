import { readArchives, canAccessArchive, canManageArchive } from './archives';
import type { ArchiveUser } from './auth';
import { archiveCapabilities } from './archive-capabilities';

export function archiveManagementContext(user: ArchiveUser, requested?: string) {
  const available = readArchives().filter(archive => canAccessArchive(archive, user) || (archive.ownerId === user.id && archive.deletingAt));
  const selected = requested ? available.find(archive => archive.id === requested) : available.find(archive => archive.ownerId === user.id) || available[0];
  const archive = selected ? { ...selected, canManage: canAccessArchive(selected, user) && canManageArchive(selected, user) } : null;
  const capabilities = archiveCapabilities(archive, user);
  return capabilities.canOpenManage ? { archive, capabilities } : null;
}
