import { Prisma } from '@prisma/client';
import type { QuerySelection } from './VectorQueryService';
/** Shared SQL scope for body and metadata readers; alias n always denotes notes. */
export function noteVisibility(accountId: number, selection?: QuerySelection) {
  const s = selection?.scope ?? {};
  const tags = [...new Set(s.tagIds ?? [])];
  const tagCondition = (ids: number[]) => Prisma.sql`EXISTS (SELECT 1 FROM "tagsToNote" t JOIN tag g ON g.id=t."tagId"
    WHERE t."noteId"=n.id AND g."accountId"=${accountId}::int AND t."tagId" IN (${Prisma.join(ids)}))`;
  return Prisma.sql`n."accountId"=${accountId}::int AND n."isRecycle"=false
    ${selection ? Prisma.sql`AND n.type IN (${Prisma.join(s.types ?? [0, 1])})
      ${s.includeArchived ? Prisma.empty : Prisma.sql`AND n."isArchived"=false`}
      ${selection.excludeNoteIds.length ? Prisma.sql`AND NOT EXISTS (
        SELECT 1 FROM unnest(${selection.excludeNoteIds}::int[]) AS excluded(id) WHERE excluded.id=n.id
      )` : Prisma.empty}
      ${s.createdFrom ? Prisma.sql`AND n."createdAt">=${new Date(s.createdFrom)}` : Prisma.empty}
      ${s.createdBefore ? Prisma.sql`AND n."createdAt"<${new Date(s.createdBefore)}` : Prisma.empty}
      ${tags.length ? Prisma.sql`AND ${s.tagMatch === 'all' ? Prisma.join(tags.map(id => tagCondition([id])), ' AND ') : tagCondition(tags)}` : Prisma.empty}` : Prisma.empty}`;
}
