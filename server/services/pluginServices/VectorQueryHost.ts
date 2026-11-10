import { Prisma, type PrismaClient } from "@prisma/client";
import type { QueryNote, QueryNoteSource, QuerySelection } from "./VectorQueryService";
import { VECTOR_QUERY_BUDGET } from "./vectorSchemas";
import { ServiceError } from "./errors";
import { createAccountRateGate, pruneRateWindows, type AccountRateGate } from "./CallPolicy";

/** Read-only model queries still create rate rows. Reclaim them even on hosts
 * that never invoke a paid service. Maintenance failure cannot authorize calls. */
export function createQueryRateGate(prisma: PrismaClient): AccountRateGate {
  const gate = createAccountRateGate({ prisma });
  let lastPrune = 0;
  return {
    ...gate,
    async acquire(accountId, limit, options) {
      if (Date.now() - lastPrune >= 300000) {
        lastPrune = Date.now();
        await pruneRateWindows(prisma).catch(() => undefined);
      }
      return gate.acquire(accountId, limit, options);
    },
  };
}

// The host supplies its existing Prisma client. This adapter never imports the
// all-resource AI factory, constructs providers, or writes notes/index metadata.
export function createQueryNoteSource(prisma: PrismaClient): QueryNoteSource {
  const visibility = (accountId: number, selection?: QuerySelection) => {
    const s = selection?.scope ?? {};
    const tags = [...new Set(s.tagIds ?? [])];
    const tagCondition = (
      ids: number[],
    ) => Prisma.sql`EXISTS (SELECT 1 FROM "tagsToNote" t JOIN tag g ON g.id=t."tagId"
      WHERE t."noteId"=n.id AND g."accountId"=${accountId}::int AND t."tagId" IN (${Prisma.join(ids)}))`;
    return Prisma.sql`n."accountId"=${accountId}::int AND n."isRecycle"=false
      ${
        selection
          ? Prisma.sql`AND n.type IN (${Prisma.join(s.types ?? [0, 1])})
        ${s.includeArchived ? Prisma.empty : Prisma.sql`AND n."isArchived"=false`}
        ${selection.excludeNoteIds.length ? Prisma.sql`AND NOT EXISTS (
          SELECT 1 FROM unnest(${selection.excludeNoteIds}::int[]) AS excluded(id) WHERE excluded.id=n.id
        )` : Prisma.empty}
        ${s.createdFrom ? Prisma.sql`AND n."createdAt">=${new Date(s.createdFrom)}` : Prisma.empty}
        ${s.createdBefore ? Prisma.sql`AND n."createdAt"<${new Date(s.createdBefore)}` : Prisma.empty}
        ${
          tags.length
            ? Prisma.sql`AND ${
                s.tagMatch === "all"
                  ? Prisma.join(
                      tags.map((id) => tagCondition([id])),
                      " AND ",
                    )
                  : tagCondition(tags)
              }`
            : Prisma.empty
        }`
          : Prisma.empty
      }`;
  };
  type Row = Omit<QueryNote, "content"> & { content: string | null };
  const fields = Prisma.sql`n.id,n."accountId",n.type,n."isArchived",n."isRecycle",n."createdAt",n."updatedAt",
    CASE WHEN octet_length(n.content)<=${VECTOR_QUERY_BUDGET.maxNoteBytes}::int THEN n.content ELSE NULL END AS content,
    ARRAY(SELECT t."tagId" FROM "tagsToNote" t JOIN tag g ON g.id=t."tagId"
      WHERE t."noteId"=n.id AND g."accountId"=n."accountId" ORDER BY t."tagId") AS "tagIds"`;
  return {
    async readOwned(accountId, noteId) {
      const rows = await prisma.$queryRaw<Row[]>(
        Prisma.sql`SELECT ${fields} FROM notes n WHERE ${visibility(accountId)} AND n.id=${noteId}::int`,
      );
      const note = rows[0];
      if (note?.content === null) throw new ServiceError("QUERY_BUDGET_EXCEEDED");
      return (note as QueryNote | undefined) ?? null;
    },
    async page(accountId, selection, afterId, take) {
      const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`SELECT ${fields} FROM notes n
        WHERE ${visibility(accountId, selection)} AND n.id>${afterId}::int ORDER BY n.id LIMIT ${take}::int`);
      const oversized = rows.findIndex((r) => r.content === null);
      return {
        notes: (oversized < 0 ? rows : rows.slice(0, oversized)) as QueryNote[],
        truncated: oversized >= 0,
      };
    },
    async recheck(accountId, selection, ids) {
      if (!ids.length) return [];
      const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`SELECT ${fields} FROM notes n
        WHERE ${visibility(accountId, selection)} AND n.id IN (${Prisma.join(ids)})`);
      return rows.filter((r) => r.content !== null) as QueryNote[];
    },
    async stamp(accountId) {
      // This is a short-lived before/after fence, not a persisted body hash.
      // PostgreSQL gives every SQL UPDATE a new tuple version: xmin identifies
      // its transaction and ctid also changes for repeated updates in that same
      // transaction. Include tableoid for partition moves. Thus even body edits
      // that preserve updatedAt invalidate the fence without hashing every body
      // twice in PostgreSQL. Per-note SHA snapshot checks still read full bodies
      // in the query/create paths. Tuple rewrites may conservatively invalidate
      // a scan; these physical identifiers never leave the service as note IDs.
      const rows = await prisma.$queryRaw<
        Array<{ stamp: string }>
      >(Prisma.sql`SELECT md5(COALESCE(string_agg(
        concat_ws(':',n.id,n.tableoid::text,n.xmin::text,n.ctid::text,n.type,n."isArchived",n."isRecycle",n."createdAt",n."updatedAt",
          (SELECT string_agg(concat_ws(':',t."tagId",t.tableoid::text,t.xmin::text,t.ctid::text),',' ORDER BY t."tagId") FROM "tagsToNote" t WHERE t."noteId"=n.id)),
        '|' ORDER BY n.id),'')) AS stamp FROM notes n WHERE n."accountId"=${accountId}::int`);
      return rows[0].stamp;
    },
  };
}
