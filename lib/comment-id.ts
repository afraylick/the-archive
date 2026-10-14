import { createHash } from 'crypto';

/** A stable identifier for legacy comments that have not yet been persisted with IDs. */
export const getLegacyCommentId = (fileId: string, index: number, comment: unknown) => (
  `legacy-${createHash('sha256').update(JSON.stringify([fileId, index, comment])).digest('hex').slice(0, 24)}`
);
