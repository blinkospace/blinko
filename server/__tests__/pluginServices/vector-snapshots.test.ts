import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { IndexLifecycle } from "../../services/pluginServices/IndexLifecycle";
import {
  createVectorSnapshotService,
  hasUsableBody,
} from "../../services/pluginServices/VectorSnapshotService";
import { VectorSnapshotStore } from "../../services/pluginServices/VectorSnapshotStore";
import {
  createPolicyStore,
  type RawPolicyRow,
} from "../../services/pluginServices/PolicyStore";
import {
  BODY_PREPROCESSING_VERSION,
  digest,
  encodingValues,
  fingerprintNoteSnapshot,
} from "../../services/pluginServices/BodyInput";
import { TOKEN_WEIGHT_VERSION } from "../../services/pluginServices/NoteAggregation";
import {
  matchesSelection,
  type QueryNote,
  type QueryNoteSource,
} from "../../services/pluginServices/VectorQueryService";
import { VECTOR_SNAPSHOT_LIMITS } from "../../../shared/lib/pluginServices/v1";

const clients: Client[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});
async function fixture(
  budget: Parameters<typeof createVectorSnapshotService>[0]["budget"] = {},
) {
  const url =
    "file:" +
    join(mkdtempSync(join(tmpdir(), "blinko-note-snapshot-")), "vectors.db");
  const client = createClient({ url });
  clients.push(client);
  const notes = new Map<number, QueryNote>();
  const writer = new IndexLifecycle(client, {
    readNote: async (id) => notes.get(id) ?? null,
  });
  await writer.initialize();
  const generation = await writer.createGeneration({
    dimensions: 3,
    modelFingerprint: "synthetic-measured-v1",
    embeddingSpaceId: "synthetic-weighted-space",
    preprocessingVersion: BODY_PREPROCESSING_VERSION,
  });
  await writer.activateGeneration(generation.generation);
  const clock = { now: 1700000000000 };
  let policy: RawPolicyRow | null = null,
    random = (n: number) => n - 1;
  const source: QueryNoteSource = {
    readOwned: async (accountId, id) => {
      const n = notes.get(id);
      return n?.accountId === accountId && !n.isRecycle ? { ...n } : null;
    },
    page: async (accountId, selection, after, take) => ({
      notes: [...notes.values()]
        .filter(
          (n) => n.id > after && matchesSelection(n, accountId, selection),
        )
        .sort((a, b) => a.id - b.id)
        .slice(0, take)
        .map((n) => ({ ...n })),
      truncated: false,
    }),
    recheck: async (accountId, selection, ids) =>
      [...notes.values()]
        .filter(
          (n) =>
            ids.includes(n.id) && matchesSelection(n, accountId, selection),
        )
        .map((n) => ({ ...n })),
    stamp: async (accountId) =>
      digest([...notes.values()].filter((n) => n.accountId === accountId)),
  };
  const withStore = async <T>(
    run: (store: VectorSnapshotStore) => Promise<T>,
  ) => {
    const connection = createClient({ url });
    try {
      return await run(new VectorSnapshotStore(connection, () => clock.now));
    } finally {
      connection.close();
    }
  };
  const rateGate = {
    check: async (_a: number, limit: number) => ({
      allowed: true,
      used: 0,
      limit,
    }),
    acquire: async (_a: number, limit: number) => ({
      allowed: true,
      used: 1,
      limit,
    }),
  };
  const service = createVectorSnapshotService({
    notes: source,
    withStore,
    budget,
    policyStore: createPolicyStore({ read: async () => policy }),
    rateGate,
    classifyMissing: async (accountId, id) => {
      const note = notes.get(id);
      return !note || note.isRecycle || note.accountId === accountId
        ? "missing"
        : "forbidden";
    },
    now: () => clock.now,
    random: (n) => random(n),
  });
  async function add(
    id: number,
    vectors: number[][] = [[1, 0, 0]],
    extra: Partial<QueryNote> = {},
    weights: number[] | null = vectors.map(() => 1),
  ) {
    const note: QueryNote = {
      id,
      accountId: 1,
      type: 0,
      isArchived: false,
      isRecycle: false,
      content: `Synthetic note ${id}`,
      tagIds: [],
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-02T00:00:00Z"),
      ...extra,
    };
    notes.set(id, note);
    if (vectors.length) {
      const texts = vectors.map((_, i) => `Synthetic chunk ${id}:${i}`),
        values = encodingValues(texts, note);
      const body = {
        texts,
        values,
        sourceHash: digest([generation.preprocessingVersion, values]),
        noteSnapshotHash: fingerprintNoteSnapshot(note),
      };
      const lease = await writer.beginRevision(note, generation, body);
      await writer.stageRevision(
        lease,
        generation,
        body,
        vectors,
        "verified",
        weights
          ? {
              version: TOKEN_WEIGHT_VERSION,
              modelFingerprint: generation.modelFingerprint,
              sourceHash: body.sourceHash,
              counts: weights,
            }
          : undefined,
      );
      await writer.publishRevision(lease, generation);
    }
    return note;
  }
  const create = () =>
    service.create(1, { aggregation: "note_level_weighted_v1" });
  return {
    url,
    client,
    writer,
    generation,
    notes,
    source,
    service,
    add,
    create,
    clock,
    withStore,
    rateGate,
    setPolicy: (row: RawPolicyRow | null) => {
      policy = row;
    },
    setRandom: (fn: (n: number) => number) => {
      random = fn;
    },
  };
}
const query = (handle: string, noteId = 1, extra = {}) => ({
  source: { kind: "note" as const, noteId },
  aggregation: "note_level_weighted_v1" as const,
  snapshotHandle: handle,
  ...extra,
});
const code = async (p: Promise<unknown>) =>
  p.then(
    () => "SUCCESS",
    (e) => e.code ?? e.message,
  );

test("preparation preserves the proof preflight when no current head survives", async () => {
  const f = await fixture({ maxMetadataBytesPerPage: 1 });
  await f.add(1);
  await f.client.execute("UPDATE blinko_ps_heads SET tombstone=1");
  expect(await code(f.create())).toBe("QUERY_BUDGET_EXCEEDED");
  expect(Number((await f.client.execute("SELECT COUNT(*) AS n FROM blinko_ps_snapshots")).rows[0].n)).toBe(0);
  expect(Number((await f.client.execute("SELECT COUNT(*) AS n FROM blinko_ps_snapshot_notes")).rows[0].n)).toBe(0);
});
test("a page with no current heads remains unprepared and releases its reservation", async () => {
  const f = await fixture();
  await f.add(1);
  await f.client.execute("UPDATE blinko_ps_heads SET tombstone=1");
  expect(await code(f.create())).toBe("INDEX_NOT_READY");
  expect(Number((await f.client.execute("SELECT COUNT(*) AS n FROM blinko_ps_snapshots")).rows[0].n)).toBe(0);
});
test("ambiguous published revisions are never collapsed into a prepared note", async () => {
  const f = await fixture();
  await f.add(1); await f.add(2); await f.add(3);
  await f.client.execute(`INSERT INTO blinko_ps_revisions(revision_id,account_id,note_id,generation,snapshot_hash,source_hash,chunk_count,epoch,state,provenance,old_revisions,created_at,expires_at)
    SELECT 'synthetic-duplicate',account_id,note_id,generation,snapshot_hash,source_hash,chunk_count,epoch,state,provenance,old_revisions,created_at,expires_at FROM blinko_ps_revisions WHERE note_id=2 AND state='published'`);
  await f.client.execute(`INSERT INTO blinko_ps_note_vectors(revision_id,account_id,note_id,generation,snapshot_hash,embedding,proof)
    SELECT 'synthetic-duplicate',account_id,note_id,generation,snapshot_hash,embedding,proof FROM blinko_ps_note_vectors WHERE note_id=2`);
  const snapshot = await f.create();
  expect(snapshot.preparedNoteCount).toBe(2);
  expect(snapshot.range.unpreparedNoteCount).toBe(1);
  expect((await f.service.query(1, query(snapshot.handle))).items.map(item => item.note.id)).toEqual([3]);
  await f.service.release(1, { handle: snapshot.handle });
});

test("Markdown eligibility excludes image-only, HTML-only and whitespace; text, links and code remain eligible", () => {
  for (const text of [
    "",
    " \n ",
    "![caption](https://example.invalid/a.png)",
    '<img src="a">',
    "<!-- secret -->",
    "[ref]: https://example.invalid",
  ])
    expect(hasUsableBody(text)).toBe(false);
  for (const text of [
    "正文",
    "[文字](https://example.invalid)",
    "`value`",
    "```js\nvalue\n```",
  ])
    expect(hasUsableBody(text)).toBe(true);
});
test("plain single-line eligibility preserves Unicode text and rejects empty Markdown constructs", () => {
  for (const text of ["Synthetic resource note 9999.", "中文正文 2026", "中文正文 2026。", "Grüße, κόσμος 42!", "𠮷野", "A (short) note: 'hello'.", "( )", "正文\n---"])
    expect(hasUsableBody(text)).toBe(true);
  for (const text of ["1. ", "1) ", "---", "***", "[ref]: https://example.invalid", "<div>hidden text</div>", "<!-- text -->"])
    expect(hasUsableBody(text)).toBe(false);
});
test("real LibSQL note scores match an independent F32 oracle and reverse the max-chunk ranking", async () => {
  const f = await fixture();
  await f.add(1, [
    [1, 0, 0],
    [0, 1, 0],
  ]);
  await f.add(2, [[1, 0, 0]]);
  await f.add(3, [[1, 1, 0]]);
  await f.add(4, [[-1, -1, 0]]);
  const snapshot = await f.create(),
    r = await f.service.query(1, query(snapshot.handle));
  // Oracle does not call the aggregation implementation: stored mean's F32 axes
  // are equal, so its cosine with (1,1,0) is 1, with (1,0,0) is sqrt(.5).
  expect(r.items.map((x) => x.note.id)).toEqual([3, 2, 4]);
  [1, Math.SQRT1_2, -1].forEach((score, i) =>
    expect(r.items[i].score).toBeCloseTo(score, 12),
  );
  expect(r.scoring.aggregation).toBe("note_level_weighted_v1");
  expect(r.retrieval).toEqual({
    algorithm: "exact",
    truncated: false,
    remaining: "no",
  });
  expect(
    r.items.every(
      (x) =>
        x.snapshot?.handle === snapshot.handle && x.snapshot.hash.length === 64,
    ),
  ).toBe(true);
});
test("unequal per-input weights are used after normalizing each stored F32 chunk", async () => {
  const f = await fixture();
  await f.add(
    1,
    [
      [1000, 0, 0],
      [0, 7, 0],
    ],
    {},
    [1, 3],
  );
  await f.add(2, [[1, 0, 0]]);
  await f.add(3, [[0, 1, 0]]);
  const r = await f.service.query(1, query((await f.create()).handle));
  expect(r.items.map((x) => x.note.id)).toEqual([3, 2]);
  expect(r.items[0].score).toBeCloseTo(3 / Math.sqrt(10), 7);
  expect(r.items[1].score).toBeCloseTo(1 / Math.sqrt(10), 7);
});
test("unknown weights cannot enable the new algorithm; a failed create removes its reservation and children", async () => {
  const f = await fixture();
  await f.add(1, [[1, 0, 0]], {}, null);
  expect(await code(f.create())).toBe("INDEX_NOT_READY");
  expect(
    Number(
      (await f.client.execute("SELECT COUNT(*) AS n FROM blinko_ps_snapshots"))
        .rows[0].n,
    ),
  ).toBe(0);
  expect(
    Number(
      (
        await f.client.execute(
          "SELECT COUNT(*) AS n FROM blinko_ps_snapshot_notes",
        )
      ).rows[0].n,
    ),
  ).toBe(0);
});
test("prepared subset and complete pre-exclusion pool count distinguish empty, one and all-excluded", async () => {
  const f = await fixture();
  await f.add(1);
  await f.add(2, [], { content: "Unprepared text" });
  await f.add(3, [[1, 0, 0]], { content: "![only image](a.png)" });
  await f.add(4, [[1, 0, 0]], { type: 2 });
  await f.add(5, [[1, 0, 0]], { isArchived: true });
  const s = await f.create();
  expect(s.preparedNoteCount).toBe(1);
  expect(s.range).toEqual({
    kind: "prepared-subset",
    eligibleNoteCount: 2,
    unpreparedNoteCount: 1,
  });
  const only = await f.service.sample(1, { handle: s.handle });
  expect(only.item?.note.id).toBe(1);
  expect(only.poolSize).toBe(1);
  expect(
    await f.service.sample(1, { handle: s.handle, excludeNoteIds: [1] }),
  ).toEqual({ item: null, poolSize: 1 });
  const empty = await f.service.create(1, {
    aggregation: "note_level_weighted_v1",
    scope: { types: [2], tagIds: [100] },
  });
  expect(await f.service.sample(1, { handle: empty.handle })).toEqual({
    item: null,
    poolSize: 0,
  });
});
test("reservoir sampling visits every eligible element and never includes the previous start", async () => {
  const f = await fixture();
  await f.add(1);
  await f.add(2);
  await f.add(3);
  const s = await f.create();
  // Enumerate all 2*3 equally likely RNG outcomes; each id must occur twice.
  const counts = [0, 0, 0];
  for (let x = 0; x < 2; x++)
    for (let y = 0; y < 3; y++) {
      const choices = [0, x, y];
      f.setRandom(() => choices.shift()!);
      const r = await f.service.sample(1, { handle: s.handle });
      counts[r.item!.note.id - 1]++;
    }
  expect(counts).toEqual([2, 2, 2]);
  f.setRandom(() => 0);
  expect(
    (await f.service.sample(1, { handle: s.handle, excludeNoteIds: [3] })).item
      ?.note.id,
  ).not.toBe(3);
});
test("body edits do not mutate the selected source vector; changed targets are skipped and lower ranks fill the limit", async () => {
  const f = await fixture();
  await f.add(1);
  await f.add(2);
  await f.add(3, [[0.9, 0.1, 0]]);
  await f.add(4, [[0, 1, 0]]);
  const s = await f.create();
  const initial = await f.service.query(1, query(s.handle, 1, { limit: 2 }));
  expect(initial.items.map((x) => x.note.id)).toEqual([2, 3]);
  const n1 = f.notes.get(1)!,
    n2 = f.notes.get(2)!;
  f.notes.set(1, {
    ...n1,
    content: "Edited source",
    updatedAt: new Date("2026-02-01"),
  });
  f.notes.set(2, {
    ...n2,
    content: "Edited target",
    updatedAt: new Date("2026-02-01"),
  });
  await f.add(1, [[0, 1, 0]], {
    content: "Edited source",
    updatedAt: new Date("2026-02-01"),
  });
  const next = await f.service.query(1, query(s.handle, 1, { limit: 2 }));
  expect(next.items.map((x) => x.note.id)).toEqual([3, 4]);
  expect(next.items[1].score).toBe(0);
  expect(next.retrieval.remaining).toBe("unknown");
  const changed = await f.service.readNote(1, {
    handle: s.handle,
    noteId: 2,
    snapshotHash: initial.items[0].snapshot!.hash,
  });
  expect(changed.status).toBe("changed");
  if (changed.status === "changed")
    expect(changed.content).toBe("Edited target");
});
test("readNote verifies exact host hash and distinguishes owned snapshot missing from forbidden without foreign handles", async () => {
  const f = await fixture();
  await f.add(1);
  await f.add(2);
  const s = await f.create(),
    sample = await f.service.sample(1, { handle: s.handle });
  const input = {
    handle: s.handle,
    noteId: sample.item!.note.id,
    snapshotHash: sample.item!.snapshot.hash,
  };
  const read = await f.service.readNote(1, input);
  expect(read.status).toBe("ok");
  if (read.status === "ok") {
    expect(read.accountId).toBe(1);
    expect(read.snapshotHash).toBe(input.snapshotHash);
  }
  expect(
    await code(
      f.service.readNote(1, { ...input, snapshotHash: "0".repeat(64) }),
    ),
  ).toBe("INVALID_INPUT");
  expect(await code(f.service.readNote(2, input))).toBe(
    "NOT_FOUND_OR_FORBIDDEN",
  );
  f.notes.set(input.noteId, { ...f.notes.get(input.noteId)!, accountId: 2 });
  expect(await f.service.readNote(1, input)).toEqual({ status: "forbidden" });
  f.notes.delete(input.noteId);
  expect(await f.service.readNote(1, input)).toEqual({ status: "missing" });
});
test("full exclusion, zero and negative scores, duplicate ids and deterministic ties are preserved", async () => {
  const f = await fixture();
  await f.add(1);
  await f.add(2, [[0, 1, 0]]);
  await f.add(3, [[0, 1, 0]]);
  await f.add(4, [[-1, 0, 0]]);
  const s = await f.create();
  const r = await f.service.query(
    1,
    query(s.handle, 1, { excludeNoteIds: [2, 2], limit: 2 }),
  );
  expect(r.items.map((x) => [x.note.id, x.score])).toEqual([
    [3, 0],
    [4, -1],
  ]);
  const empty = await f.service.query(
    1,
    query(s.handle, 1, { excludeNoteIds: [2, 3, 4] }),
  );
  expect(empty.items).toHaveLength(0);
  expect(empty.retrieval.remaining).toBe("no");
});
test("new same-generation notes stay outside an existing immutable prepared pool", async () => {
  const f = await fixture();
  await f.add(1);
  await f.add(2);
  const s = await f.create();
  await f.add(3);
  const r = await f.service.query(1, query(s.handle));
  expect(r.items.map((x) => x.note.id)).toEqual([2]);
  expect(r.index.corpusRevision).toBe(s.index.corpusRevision);
  expect((await f.service.sample(1, { handle: s.handle })).poolSize).toBe(2);
});
test("deletion and permission loss override frozen source data", async () => {
  const f = await fixture();
  await f.add(1);
  await f.add(2);
  const s = await f.create();
  f.notes.set(1, { ...f.notes.get(1)!, isRecycle: true });
  expect(await code(f.service.query(1, query(s.handle)))).toBe(
    "NOT_FOUND_OR_FORBIDDEN",
  );
  await f.writer.deleteNote(1, 2);
  expect((await f.service.sample(1, { handle: s.handle })).poolSize).toBe(0);
});
test("generation fences, expiry and release reject stale handles; foreign and forged handles have one error", async () => {
  const f = await fixture();
  await f.add(1);
  const s = await f.create();
  expect(await code(f.service.sample(2, { handle: s.handle }))).toBe(
    "NOT_FOUND_OR_FORBIDDEN",
  );
  expect(
    await code(
      f.service.sample(1, { handle: "11111111-1111-4111-8111-111111111111" }),
    ),
  ).toBe("NOT_FOUND_OR_FORBIDDEN");
  const next = await f.writer.createGeneration({
    ...f.generation,
    embeddingSpaceId: "new-space",
  });
  await f.writer.activateGeneration(next.generation);
  expect(await code(f.service.sample(1, { handle: s.handle }))).toBe(
    "INDEX_CHANGED",
  );
  await f.writer.activateGeneration(f.generation.generation);
  f.clock.now += VECTOR_SNAPSHOT_LIMITS.ttlMs + 1;
  expect(await code(f.service.sample(1, { handle: s.handle }))).toBe(
    "INDEX_CHANGED",
  );
  await f.service.release(1, { handle: s.handle });
  expect(await code(f.service.sample(1, { handle: s.handle }))).toBe(
    "NOT_FOUND_OR_FORBIDDEN",
  );
});
test("account count and host-byte reservations are enforced transactionally and expired payloads are pruned", async () => {
  const f = await fixture();
  await f.add(1);
  const a = await f.create(),
    b = await f.create();
  expect(await code(f.create())).toBe("QUERY_BUDGET_EXCEEDED");
  await f.service.release(1, { handle: a.handle });
  await f.create();
  f.clock.now += VECTOR_SNAPSHOT_LIMITS.ttlMs + 1;
  const fresh = await f.create();
  expect(
    (
      await f.client.execute({
        sql: "SELECT COUNT(*) AS n FROM blinko_ps_snapshot_notes WHERE handle=?",
        args: [b.handle],
      })
    ).rows[0].n,
  ).toBe(0);
  expect((await f.service.sample(1, { handle: fresh.handle })).poolSize).toBe(
    1,
  );
});
test("policy and scope limits are enforced on snapshot methods while disabled services can still release", async () => {
  const f = await fixture();
  await f.add(1);
  await f.add(2);
  const s = await f.create();
  f.setPolicy({ limits: { maxExcludeIds: 1, maxResults: 1 } });
  expect(
    await code(
      f.service.sample(1, { handle: s.handle, excludeNoteIds: [1, 2] }),
    ),
  ).toBe("INVALID_INPUT");
  expect(await code(f.service.query(1, query(s.handle, 1, { limit: 2 })))).toBe(
    "INVALID_INPUT",
  );
  expect(
    await code(
      f.service.query(
        1,
        query(s.handle, 1, { scope: { types: [1] }, limit: 1 }),
      ),
    ),
  ).toBe("INVALID_INPUT");
  f.setPolicy({ features: { "vector.snapshots": { enabled: false } } });
  expect(await code(f.service.sample(1, { handle: s.handle }))).toBe(
    "CAPABILITY_UNSUPPORTED",
  );
  await f.service.release(1, { handle: s.handle });
});
test("independent processes cannot race account counts or the host byte reservation cap", async () => {
  const f = await fixture();
  const worker = join(import.meta.dir, "helpers/snapshotProcessWorker.ts");
  async function run(accounts: number[]) {
    const children = accounts.map((account) =>
      Bun.spawn([process.execPath, worker, f.url, String(account)], {
        env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    return Promise.all(
      children.map(async (child) => {
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(exit).toBe(0);
        expect(stderr).toBe("");
        return JSON.parse(stdout);
      }),
    );
  }
  const sameAccount = await run(Array(6).fill(1));
  console.log(
    JSON.stringify({
      fixture: "snapshot-account-quota",
      parentPid: process.pid,
      children: sameAccount,
    }),
  );
  expect(new Set(sameAccount.map((r) => r.pid)).size).toBe(6);
  expect(sameAccount.filter((r) => r.code === "OK")).toHaveLength(2);
  expect(
    sameAccount.filter((r) => r.code === "QUERY_BUDGET_EXCEEDED"),
  ).toHaveLength(4);
  for (const r of sameAccount.filter((r) => r.code === "OK"))
    await f.withStore((s) => s.release(1, r.handle));
  const host = await run(Array.from({ length: 12 }, (_, i) => i + 2));
  console.log(
    JSON.stringify({
      fixture: "snapshot-process-quota",
      parentPid: process.pid,
      sameAccount,
      host,
    }),
  );
  expect(new Set(host.map((r) => r.pid)).size).toBe(12);
  expect(host.filter((r) => r.code === "OK")).toHaveLength(8);
  expect(host.filter((r) => r.code === "QUERY_BUDGET_EXCEEDED")).toHaveLength(
    4,
  );
  const totals = (
    await f.client.execute(
      "SELECT COUNT(*) AS n,SUM(reserved_bytes) AS bytes FROM blinko_ps_snapshots WHERE state='building'",
    )
  ).rows[0];
  expect(Number(totals.n)).toBe(8);
  expect(Number(totals.bytes)).toBe(VECTOR_SNAPSHOT_LIMITS.maxHostBytes);
  console.log(
    JSON.stringify({
      fixture: "snapshot-process-quota",
      parentPid: process.pid,
      sameAccount,
      host,
    }),
  );
});
test("an unstable corpus never publishes a pool or reports a guessed poolSize", async () => {
  const f = await fixture();
  await f.add(1);
  const base = f.source.stamp;
  let calls = 0;
  f.source.stamp = async (account) => `${await base(account)}:${calls++}`;
  expect(await code(f.create())).toBe("INDEX_CHANGED");
  expect(
    Number(
      (await f.client.execute("SELECT COUNT(*) AS n FROM blinko_ps_snapshots"))
        .rows[0].n,
    ),
  ).toBe(0);
  f.source.stamp = base;
  const s = await f.create();
  f.source.stamp = async (account) => `${await base(account)}:${calls++}`;
  expect(await code(f.service.sample(1, { handle: s.handle }))).toBe(
    "INDEX_CHANGED",
  );
});

test("scanned notes, including image-only entries, consume the preparation budget", async () => {
  const f = await fixture({ maxNotes: 2 });
  for (let i = 1; i <= 3; i++)
    await f.add(i, [], { content: "![image](a.png)" });
  expect(await code(f.create())).toBe("QUERY_BUDGET_EXCEEDED");
  expect(
    Number(
      (await f.client.execute("SELECT COUNT(*) AS n FROM blinko_ps_snapshots"))
        .rows[0].n,
    ),
  ).toBe(0);
});
test("complete sample counts are refused when scanning exceeds the computation budget", async () => {
  const f = await fixture({ timeoutMs: 10 });
  await f.add(1);
  const s = await f.create();
  const read = f.source.recheck;
  f.source.recheck = async (...args) => {
    const notes = await read(...args);
    f.clock.now += 11;
    return notes;
  };
  expect(await code(f.service.sample(1, { handle: s.handle }))).toBe(
    "QUERY_BUDGET_EXCEEDED",
  );
});
test("a timed-out rate check cannot later create an orphaned snapshot", async () => {
  const f = await fixture({ hardTimeoutMs: 40 });
  await f.add(1);
  let allow!: () => void;
  f.rateGate.acquire = async (_a, limit) => {
    await new Promise<void>((resolve) => {
      allow = resolve;
    });
    return { allowed: true, used: 1, limit };
  };
  expect(await code(f.create())).toBe("TIMEOUT");
  allow();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(
    Number(
      (await f.client.execute("SELECT COUNT(*) AS n FROM blinko_ps_snapshots"))
        .rows[0].n,
    ),
  ).toBe(0);
});
test("snapshot pages preserve vectors and roll back both rows and accounting on a duplicate", async () => {
  const f = await fixture();
  await f.withStore(async (store) => {
    const handle = await store.reserve(1);
    const entry = (noteId: number) => ({ noteId, hash: String(noteId).padStart(64, "0"), vector: [1, 0, 0] });
    try {
      await store.add(handle, 1, [entry(1)]);
      const accounting = () => f.client.execute({
        sql: "SELECT written_bytes,note_count FROM blinko_ps_snapshots WHERE handle=?",
        args: [handle],
      });
      const before = await accounting();
      await expect(store.add(handle, 1, [entry(2), entry(1)])).rejects.toThrow();
      expect((await accounting()).rows).toEqual(before.rows);
      expect((await store.page(handle, 0)).map((e) => e.noteId)).toEqual([1]);
      await store.add(handle, 1, Array.from({ length: 128 }, (_, i) => entry(i + 2)));
      expect((await store.page(handle, 0)).map((e) => e.noteId)).toEqual(Array.from({ length: 128 }, (_, i) => i + 1));
      expect((await store.page(handle, 128)).map((e) => e.noteId)).toEqual([129]);
      expect((await store.vectors(handle, [2, 129], 3)).get(129)).toEqual([1, 0, 0]);
      expect(Number((await accounting()).rows[0].note_count)).toBe(129);
      const own = await accounting();
      expect(await code(store.add(handle, 2, [entry(130)]))).toBe("INDEX_CHANGED");
      expect((await accounting()).rows).toEqual(own.rows);
    } finally {
      await store.release(1, handle);
    }
    expect((await f.client.execute("SELECT COUNT(*) AS n FROM blinko_ps_snapshot_notes")).rows[0].n).toBe(0);
  });
});
test("transactional payload accounting prevents adding beyond a reserved snapshot", async () => {
  const f = await fixture();
  await f.withStore(async (store) => {
    const handle = await store.reserve(1);
    await f.client.execute({
      sql: "UPDATE blinko_ps_snapshots SET written_bytes=? WHERE handle=?",
      args: [VECTOR_SNAPSHOT_LIMITS.maxSnapshotBytes, handle],
    });
    expect(
      await code(
        store.add(handle, 1, [
          { noteId: 1, hash: "0".repeat(64), vector: [1, 0, 0] },
        ]),
      ),
    ).toBe("QUERY_BUDGET_EXCEEDED");
    expect(
      Number(
        (
          await f.client.execute(
            "SELECT COUNT(*) AS n FROM blinko_ps_snapshot_notes",
          )
        ).rows[0].n,
      ),
    ).toBe(0);
  });
});
