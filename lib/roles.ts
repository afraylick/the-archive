export type UserRole = 'owner' | 'admin' | 'member';

export interface AccountAccess {
  id: string;
  role: UserRole;
}

export const roleLabel = (role: UserRole) => ({ owner: 'Owner', admin: 'Site Admin', member: 'Member' })[role];

export const canEditAccount = (actor: AccountAccess, target: AccountAccess) => (
  actor.role === 'owner' || (actor.role === 'admin' && (target.role === 'member' || actor.id === target.id))
);

export const canChangeAccountRole = (actor: AccountAccess, target: AccountAccess) => (
  actor.role === 'owner' && target.role !== 'owner'
);

export const BUILT_IN_USER_IDS = new Set(['adam', 'maurer', 'wills', 'jordi', 'roland']);

export const canDeleteAccount = (actor: AccountAccess, target: AccountAccess) => (
  canEditAccount(actor, target) && target.role !== 'owner' && !BUILT_IN_USER_IDS.has(target.id) && actor.id !== target.id
);
