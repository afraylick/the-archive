/** UI capabilities are separate from recording-edit and site-account permissions. */
export function archiveCapabilities(archive: { ownerId: string; canManage?: boolean; deletingAt?: string } | null | undefined, user: { id: string; isAdmin: boolean; archiveScopeId?: string } | null | undefined) {
  const isArchiveAdmin = Boolean(archive && user && !user.archiveScopeId && archive.ownerId === user.id);
  const activeAdmin = isArchiveAdmin && !archive?.deletingAt;
  return {
    isArchiveAdmin,
    canOpenManage: Boolean(user?.isAdmin || isArchiveAdmin),
    canViewActivity: activeAdmin,
    canManageSettings: activeAdmin,
    canManageAccounts: activeAdmin,
    canManageRecordings: Boolean(archive?.canManage && !archive.deletingAt),
  };
}
