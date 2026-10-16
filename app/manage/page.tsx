import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getUserFromSessionToken, getUsersForViewer, SESSION_COOKIE } from '@/lib/auth';
import { archiveManagementContext } from '@/lib/archive-management';
import ManageClient from './manage-client';

export default async function ManagePage({ searchParams }: { searchParams: Promise<{ archive?: string; section?: string }> }) {
  const user = getUserFromSessionToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect('/login?next=%2Fmanage');
  const query = await searchParams;
  const requested = typeof query.archive === 'string' ? query.archive : undefined;
  const context = archiveManagementContext(user, requested);
  if (!context) redirect(requested ? `/?archive=${encodeURIComponent(requested)}` : '/');
  if (!requested && context.archive) {
    const params = new URLSearchParams({ archive: context.archive.id });
    if (typeof query.section === 'string') params.set('section', query.section);
    redirect(`/manage?${params}`);
  }
  return <ManageClient key={context.archive?.id || 'site'} archive={context.archive} user={user} people={getUsersForViewer(user)} capabilities={context.capabilities} requestedSection={typeof query.section === 'string' ? query.section : undefined}/>;
}
