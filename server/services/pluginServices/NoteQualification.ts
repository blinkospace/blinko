import { Prisma, type PrismaClient } from '@prisma/client';
import { BODY_PREPROCESSING_VERSION, digest, fingerprintNoteSnapshot } from './BodyInput';
import { BODY_ELIGIBILITY_VERSION, hasUsableBody } from './BodyEligibility';
import { noteVisibility } from './NoteSelection';
import { ServiceError } from './errors';
import { VECTOR_QUERY_BUDGET } from './vectorSchemas';
import type { QueryNote, QuerySelection } from './VectorQueryService';

export const QUALIFICATION_RULE = digest(['note-qualification-v1', BODY_PREPROCESSING_VERSION, BODY_ELIGIBILITY_VERSION]);
export interface QualifiedNote extends Omit<QueryNote, 'content'> {
  instance: string;
  qualificationVersion: string;
  snapshotHash: string | null;
  usableBody: boolean | null;
  bodyBytes: number;
}
export interface QualificationSource {
  ensureReady(accountId: number): Promise<void>;
  stamp(accountId: number): Promise<string>;
  page(accountId: number, selection: QuerySelection, afterId: number, take: number): Promise<QualifiedNote[]>;
  recheck(accountId: number, selection: QuerySelection, ids: number[]): Promise<QualifiedNote[]>;
  identity(noteId: number): Promise<{ instance: string; snapshotHash: string; version: string } | null>;
}
const TRIGGERS = [
  'blinko_ps_note_qualification_change', 'blinko_ps_tag_link_qualification_change',
  'blinko_ps_tag_owner_qualification_change', 'blinko_ps_note_qualification_truncate',
  'blinko_ps_tag_link_qualification_truncate', 'blinko_ps_tag_owner_qualification_truncate',
];
const TABLES = ['notes', 'tagsToNote', 'tag', 'plugin_note_qualification', 'plugin_note_registry', 'plugin_note_fence'];

/** Explicit initialization and changed-note certification. No provider or SQLite access. */
export class NoteQualificationRegistry implements QualificationSource {
  constructor(readonly prisma: PrismaClient) {}

  async schemaSignature(): Promise<string> {
    const tables = await this.prisma.$queryRaw<Array<{ oid: string; relname: string; relfilenode: string }>>(Prisma.sql`
      SELECT c.oid::text,c.relname,c.relfilenode::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=current_schema() AND c.relname IN (${Prisma.join(TABLES)}) ORDER BY c.relname`);
    const triggers = await this.prisma.$queryRaw<Array<Record<string, string>>>(Prisma.sql`
      SELECT t.oid::text,t.tgname,t.tgenabled::text,t.xmin::text,pg_get_triggerdef(t.oid) definition,
        p.oid::text function_oid,p.xmin::text function_xmin,pg_get_functiondef(p.oid) function_definition
      FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname=current_schema() AND t.tgname IN (${Prisma.join(TRIGGERS)}) ORDER BY t.tgname`);
    // Helper function bodies are also part of the trusted write path.
    const functions = await this.prisma.$queryRaw<Array<Record<string, string>>>(Prisma.sql`
      SELECT p.oid::text,p.proname,p.xmin::text,pg_get_functiondef(p.oid) definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=current_schema() AND p.proname IN ('blinko_ps_qualification_fence','blinko_ps_qualification_touch') ORDER BY p.proname`);
    if (tables.length !== TABLES.length || triggers.length !== TRIGGERS.length || functions.length !== 2 || triggers.some(t => t.tgenabled !== 'O'))
      throw new ServiceError('INDEX_NOT_READY');
    // Do not include pg_class.xmin: normal ANALYZE updates statistics without changing content.
    return digest([tables, triggers, functions, QUALIFICATION_RULE]);
  }

  private async trusted(): Promise<string> {
    const signature = await this.schemaSignature();
    const rows = await this.prisma.$queryRaw<Array<{ trusted: boolean; schemaSignature: string; ruleVersion: string }>>`
      SELECT trusted,"schemaSignature","ruleVersion" FROM plugin_note_registry WHERE id=1`;
    if (!rows[0]?.trusted || rows[0].schemaSignature !== signature || rows[0].ruleVersion !== QUALIFICATION_RULE)
      throw new ServiceError('INDEX_NOT_READY');
    return signature;
  }

  async stamp(accountId: number): Promise<string> {
    const signature = await this.trusted();
    const rows = await this.prisma.$queryRaw<Array<{ version: string }>>`
      SELECT version::text FROM plugin_note_fence WHERE "accountId"=${accountId}::int`;
    return `${signature}:${rows[0]?.version ?? '0'}`;
  }

  async pending(accountId: number | null = null): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count FROM notes n LEFT JOIN plugin_note_qualification q ON q."noteId"=n.id
      WHERE (${accountId}::int IS NULL OR n."accountId"=${accountId}::int)
        AND (q."noteId" IS NULL OR q.state<>'certified' OR q."ruleVersion" IS DISTINCT FROM ${QUALIFICATION_RULE})`;
    return Number(rows[0].count);
  }

  async certifyBatch(accountId: number | null = null, take = 128): Promise<{ read: number; certified: number }> {
    if (!Number.isSafeInteger(take) || take < 1 || take > 128) throw new ServiceError('INVALID_INPUT');
    const rows = await this.prisma.$queryRaw<Array<{
      id: number; accountId: number | null; content: string | null; createdAt: Date; updatedAt: Date;
      instance: string; version: string; bytes: bigint;
    }>>`
      SELECT n.id,n."accountId",n."createdAt",n."updatedAt",q.instance::text,q.version::text,
        octet_length(n.content)::bigint bytes,
        CASE WHEN octet_length(n.content)<=${VECTOR_QUERY_BUDGET.maxNoteBytes}::int THEN n.content ELSE NULL END content
      FROM notes n JOIN plugin_note_qualification q ON q."noteId"=n.id
      WHERE (${accountId}::int IS NULL OR n."accountId"=${accountId}::int)
        AND (q.state<>'certified' OR q."ruleVersion" IS DISTINCT FROM ${QUALIFICATION_RULE}) ORDER BY n.id LIMIT ${take}::int`;
    let certified = 0;
    for (const row of rows) {
      const hash = row.content === null ? null : fingerprintNoteSnapshot({ ...row, accountId: row.accountId ?? 0, content: row.content });
      const usable = row.content === null ? null : hasUsableBody(row.content);
      const changed = await this.prisma.$transaction(async tx => {
        const updated = await tx.$queryRaw<Array<{ accountId: number | null }>>`
          UPDATE plugin_note_qualification SET state='certified',"snapshotHash"=${hash},"usableBody"=${usable},
            "bodyBytes"=${row.bytes}::bigint,"ruleVersion"=${QUALIFICATION_RULE}
          WHERE "noteId"=${row.id}::int AND instance=${row.instance}::uuid AND version=${row.version}::bigint
          RETURNING "accountId"`;
        if (updated.length && updated[0].accountId !== null)
          await tx.$executeRaw`SELECT blinko_ps_qualification_fence(${updated[0].accountId}::int)`;
        return updated.length;
      });
      certified += changed;
    }
    return { read: rows.length, certified };
  }

  /** Host operator only. A partial/failed initialization never marks the registry trusted. */
  async initialize(options: { maxNotes?: number; timeoutMs?: number } = {}) {
    const maxNotes = options.maxNotes ?? 50_000, timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(maxNotes) || maxNotes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
      throw new ServiceError('INVALID_INPUT');
    const before = await this.schemaSignature(), started = performance.now();
    const prior = await this.prisma.$queryRaw<Array<{ trusted: boolean; initializing: boolean; schemaSignature: string; ruleVersion: string }>>`
      SELECT trusted,initializing,"schemaSignature","ruleVersion" FROM plugin_note_registry WHERE id=1`;
    const resumable = prior[0]?.initializing && !prior[0].trusted && prior[0].schemaSignature === before && prior[0].ruleVersion === QUALIFICATION_RULE;
    // Resume a bounded explicit initialization without losing prior progress.
    // A trusted registry, changed schema/rule, or TRUNCATE starts a new instance epoch.
    if (!resumable) await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`UPDATE plugin_note_registry SET trusted=false,initializing=true,"schemaSignature"=${before},"ruleVersion"=${QUALIFICATION_RULE} WHERE id=1`;
      await tx.$executeRaw`INSERT INTO plugin_note_qualification("noteId","accountId") SELECT id,"accountId" FROM notes ON CONFLICT("noteId") DO NOTHING`;
      await tx.$executeRaw`UPDATE plugin_note_qualification SET instance=gen_random_uuid(),state='dirty',"snapshotHash"=NULL,"usableBody"=NULL,"ruleVersion"=NULL`;
    });
    let scanned = 0, certified = 0;
    for (;;) {
      if (performance.now() - started >= timeoutMs || scanned >= maxNotes) break;
      const result = await this.certifyBatch(null, Math.min(128, maxNotes - scanned));
      scanned += result.read; certified += result.certified;
      if (!result.read) break;
    }
    const pending = await this.pending();
    if (pending || before !== await this.schemaSignature()) return { ready: false, scanned, certified, pending };
    const changed = await this.prisma.$executeRaw`
      UPDATE plugin_note_registry SET trusted=true,initializing=false WHERE id=1 AND "schemaSignature"=${before} AND "ruleVersion"=${QUALIFICATION_RULE}
      AND NOT EXISTS (SELECT 1 FROM notes n LEFT JOIN plugin_note_qualification q ON q."noteId"=n.id
        WHERE q."noteId" IS NULL OR q.state<>'certified' OR q."ruleVersion" IS DISTINCT FROM ${QUALIFICATION_RULE})`;
    return { ready: changed === 1, scanned, certified, pending: await this.pending() };
  }

  /** Explicit bulk maintenance after ordinary DML; preserves note instances. */
  async maintain(options: { maxNotes?: number; timeoutMs?: number } = {}) {
    await this.trusted();
    const maxNotes = options.maxNotes ?? 50_000, timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(maxNotes) || maxNotes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new ServiceError('INVALID_INPUT');
    const started = performance.now(); let scanned = 0, certified = 0;
    while (scanned < maxNotes && performance.now() - started < timeoutMs) {
      const result = await this.certifyBatch(null, Math.min(128, maxNotes - scanned));
      scanned += result.read; certified += result.certified; if (!result.read) break;
    }
    await this.trusted();
    const pending = await this.pending();
    return { ready: pending === 0, scanned, certified, pending };
  }

  async ensureReady(accountId: number): Promise<void> {
    await this.trusted();
    const pending = await this.pending(accountId);
    if (pending > 4) throw new ServiceError('INDEX_NOT_READY');
    if (pending) await this.certifyBatch(accountId, 4);
    if (await this.pending(accountId)) throw new ServiceError('INDEX_NOT_READY');
  }

  private fields = Prisma.sql`n.id,n."accountId",n.type,n."isArchived",n."isRecycle",n."createdAt",n."updatedAt",
    q.instance::text,q.version::text AS "qualificationVersion",q.state,q."snapshotHash",q."usableBody",q."bodyBytes"::text,q."ruleVersion",
    ARRAY(SELECT t."tagId" FROM "tagsToNote" t JOIN tag g ON g.id=t."tagId"
      WHERE t."noteId"=n.id AND g."accountId"=n."accountId" ORDER BY t."tagId") AS "tagIds"`;
  private decode(rows: Array<QualifiedNote & { state: string; ruleVersion: string }>, bounded = true): QualifiedNote[] {
    for (const row of rows) {
      if (row.state !== 'certified' || row.ruleVersion !== QUALIFICATION_RULE) throw new ServiceError('INDEX_NOT_READY');
      row.bodyBytes = Number(row.bodyBytes);
      if (bounded && row.bodyBytes > VECTOR_QUERY_BUDGET.maxNoteBytes) throw new ServiceError('QUERY_BUDGET_EXCEEDED');
      if (bounded && (row.snapshotHash === null || row.usableBody === null)) throw new ServiceError('INDEX_NOT_READY');
    }
    return rows;
  }
  async page(accountId: number, selection: QuerySelection, afterId: number, take: number): Promise<QualifiedNote[]> {
    if (!Number.isSafeInteger(take) || take < 1 || take > 128) throw new ServiceError('INVALID_INPUT');
    const rows = await this.prisma.$queryRaw<Array<QualifiedNote & { state: string; ruleVersion: string }>>(Prisma.sql`
      SELECT ${this.fields} FROM notes n LEFT JOIN plugin_note_qualification q ON q."noteId"=n.id
      WHERE ${noteVisibility(accountId, selection)} AND n.id>${afterId}::int ORDER BY n.id LIMIT ${take}::int`);
    return this.decode(rows);
  }
  async recheck(accountId: number, selection: QuerySelection, ids: number[]): Promise<QualifiedNote[]> {
    if (!ids.length) return [];
    if (ids.length > 128) throw new ServiceError('QUERY_BUDGET_EXCEEDED');
    const rows = await this.prisma.$queryRaw<Array<QualifiedNote & { state: string; ruleVersion: string }>>(Prisma.sql`
      SELECT ${this.fields} FROM notes n LEFT JOIN plugin_note_qualification q ON q."noteId"=n.id
      WHERE ${noteVisibility(accountId, selection)} AND n.id IN (${Prisma.join(ids)})`);
    return this.decode(rows, false);
  }
  async identity(noteId: number) {
    await this.trusted();
    const rows = await this.prisma.$queryRaw<Array<{ instance: string; snapshotHash: string | null; version: string; state: string; ruleVersion: string }>>`
      SELECT instance::text,"snapshotHash",version::text,state,"ruleVersion" FROM plugin_note_qualification WHERE "noteId"=${noteId}::int`;
    const row = rows[0];
    if (!row) return null;
    if (row.state !== 'certified' || row.ruleVersion !== QUALIFICATION_RULE || !row.snapshotHash) throw new ServiceError('INDEX_NOT_READY');
    return { instance: row.instance, snapshotHash: row.snapshotHash, version: row.version };
  }
}
