// Incremental synthetic resource measurements. Each query case uses a fresh
// process, so seeding allocations and previous cases cannot inflate its RSS.
import { PrismaClient } from '@prisma/client';
import { createClient } from '@libsql/client';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { cpus, release } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { IndexLifecycle } from '../services/pluginServices/IndexLifecycle';
import { indexTable, openVectorReader } from '../services/pluginServices/VectorRepository';
import { BODY_PREPROCESSING_VERSION, fingerprintNoteSnapshot, digest } from '../services/pluginServices/BodyInput';
import { createQueryNoteSource } from '../services/pluginServices/VectorQueryHost';
import { createPolicyStore } from '../services/pluginServices/PolicyStore';
import { createAccountRateGate, createCallPolicy } from '../services/pluginServices/CallPolicy';
import { createVectorQueryService } from '../services/pluginServices/VectorQueryService';
import { VECTOR_QUERY_BUDGET } from '../services/pluginServices/vectorSchemas';

if (process.env.PLUGIN_SERVICES_TEST_DB !== '1' || !process.env.DATABASE_URL)
  throw new Error('Dedicated PostgreSQL required');
const db = new URL(process.env.DATABASE_URL);
if (db.hostname !== '127.0.0.1' || db.username !== 'blinko_test') throw new Error('Wrong database');
globalThis.fetch = (() => { throw new Error('External network forbidden in synthetic resource measurements'); }) as typeof fetch;
const dimensions = 1024;
const date = new Date('2026-01-01T00:00:00Z');
interface Scenario { notes: number; targetChunks: number; sourceChunks: number; explicitExclusions: number }
interface Fixture extends Scenario { accountId: number; sourceId: number; excludeIds: number[]; url: string }
const scenarios: Scenario[] = [
  { notes: 1000, targetChunks: 1, sourceChunks: 1, explicitExclusions: 0 },
  { notes: 10000, targetChunks: 1, sourceChunks: 1, explicitExclusions: 0 },
  { notes: 50000, targetChunks: 1, sourceChunks: 1, explicitExclusions: 0 },
  { notes: 1000, targetChunks: 4, sourceChunks: 4, explicitExclusions: 0 },
  { notes: 10000, targetChunks: 4, sourceChunks: 4, explicitExclusions: 0 },
  { notes: 1000, targetChunks: 4, sourceChunks: 64, explicitExclusions: 0 },
  { notes: 10000, targetChunks: 1, sourceChunks: 1, explicitExclusions: 5000 },
  { notes: 1000, targetChunks: 1, sourceChunks: 1, explicitExclusions: 990 },
];

async function measure(fixture: Fixture, output: string) {
  const prisma = new PrismaClient();
  const shared = new SharedArrayBuffer(24);
  const cells = new BigInt64Array(shared);
  const sampler = new Worker(new URL('./helpers/vector-memory-sampler.ts', import.meta.url).href);
  await new Promise<void>((resolve, reject) => {
    sampler.onmessage = () => resolve();
    sampler.onerror = reject;
    sampler.postMessage({ type: 'start', buffer: shared, intervalMs: 5 });
  });
  const baseline = process.memoryUsage();
  let sqlMs = 0, vectorMs = 0;
  const raw = createQueryNoteSource(prisma);
  const notes = Object.fromEntries(Object.entries(raw).map(([key, fn]) => [key, async (...args: unknown[]) => {
    const at = performance.now();
    try { return await (fn as Function)(...args); }
    finally { sqlMs += performance.now() - at; }
  }])) as typeof raw;
  const service = createVectorQueryService({
    notes,
    policyStore: createPolicyStore({ read: async () => null }),
    rateGate: createAccountRateGate({ prisma }),
    callPolicy: createCallPolicy({ prisma }),
    resolveEmbedding: async () => { throw new Error('Models forbidden'); },
    withReader: async run => {
      const repository = (await openVectorReader(fixture.url))!;
      const timed = new Proxy(repository, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== 'function') return value;
          return async (...args: unknown[]) => {
            const at = performance.now();
            try { return await value.apply(target, args); }
            finally { vectorMs += performance.now() - at; }
          };
        },
      });
      try { return await run(timed); }
      finally { repository.client.close(); }
    },
  });
  const samples: Record<string, unknown>[] = [];
  try {
    for (let i = 0; i < (fixture.notes === 50000 ? 4 : 11); i++) {
      sqlMs = vectorMs = 0;
      const before = process.memoryUsage();
      const at = performance.now();
      const result = await service.query(fixture.accountId, {
        source: { kind: 'note', noteId: fixture.sourceId },
        excludeNoteIds: fixture.excludeIds,
        limit: 10,
      });
      const totalMs = performance.now() - at;
      const after = process.memoryUsage();
      samples.push({ totalMs, sqlMs, vectorMs, scoreAndAssemblyMs: Math.max(0, totalMs-sqlMs-vectorMs),
        rssBeforeBytes: before.rss, rssAfterBytes: after.rss, heapUsedAfterBytes: after.heapUsed,
        returned: result.items.length, retrieval: result.retrieval, coverage: result.index.coverage });
    }
    await new Promise<void>(resolve => {
      sampler.onmessage = () => resolve();
      sampler.postMessage({ type: 'stop' });
    });
    const after = process.memoryUsage();
    const observedPeak = Math.max(baseline.rss, after.rss, Number(Atomics.load(cells, 0)),
      ...samples.flatMap(item => [Number(item.rssBeforeBytes), Number(item.rssAfterBytes)]));
    const warm = samples.slice(1).map(item => Number(item.totalMs)).sort((a,b) => a-b);
    writeFileSync(output, JSON.stringify({
      ...fixture, excludeIds: undefined, url: undefined, accountId: undefined, sourceId: undefined,
      processId: process.pid, dimensions,
      explicitExcludedRatio: fixture.excludeIds.length / (fixture.notes - 1),
      candidateNotesBeforeExclusions: fixture.notes - 1,
      candidateNotesAfterExclusions: fixture.notes - 1 - fixture.excludeIds.length,
      autoExcludedSourceNotes: 1,
      memory: { rssBaselineBytes: baseline.rss, rssAfterBytes: after.rss, observedPeakRssBytes: observedPeak,
        observedRssGrowthBytes: observedPeak - baseline.rss, targetSamplingIntervalMs: 5,
        sampleCount: Number(Atomics.load(cells, 1)), maxObservedSamplingGapMs: Number(Atomics.load(cells, 2))/1000,
        boundary: 'Observed process RSS sampled by a separate thread, including that thread and native libraries. Seeding and other scenarios run outside this process. Not a kernel absolute high-water mark; PostgreSQL process memory and OS caches are not included.' },
      samples, warmP50Ms: warm[Math.floor(warm.length * .5)],
      warmP95Ms: warm[Math.min(warm.length-1, Math.ceil(warm.length*.95)-1)],
    }, null, 2)+'\n', { flag: 'wx' });
  } finally {
    sampler.terminate();
    await prisma.$disconnect();
  }
}

async function seed(prisma: PrismaClient, scenario: Scenario, folder: string): Promise<Fixture> {
  mkdirSync(folder);
  const accountId = (await prisma.accounts.create({ data: { name: 'synthetic-resource-'+randomUUID() } })).id;
  const url = 'file:'+path.join(folder, 'vectors.db');
  const client = createClient({ url });
  try {
    for (let offset=0; offset<scenario.notes; offset+=1000) {
      await prisma.notes.createMany({ data: Array.from({ length: Math.min(1000, scenario.notes-offset) }, (_,i) => ({
        accountId, content: `Synthetic resource note ${offset+i}.`, createdAt: date, updatedAt: date,
      })) });
    }
    const rows = await prisma.notes.findMany({ where: { accountId }, orderBy: { id: 'asc' },
      select: { id: true, accountId: true, content: true, createdAt: true, updatedAt: true } });
    const lifecycle = new IndexLifecycle(client, { readNote: async () => null });
    await lifecycle.initialize();
    const generation = await lifecycle.createGeneration({ dimensions, embeddingSpaceId: 'synthetic-resources-1024',
      modelFingerprint: 'synthetic-resources', preprocessingVersion: BODY_PREPROCESSING_VERSION });
    const blobs = Array.from({ length: Math.max(scenario.sourceChunks, scenario.targetChunks) }, (_,i) => {
      const vector = new Float32Array(dimensions); vector[0]=1; vector[1]=i/4; vector[2]=.25;
      return Buffer.from(vector.buffer);
    });
    for (let start=0; start<rows.length; start+=250) {
      const tx = await client.transaction('write');
      try {
        for (const row of rows.slice(start,start+250)) {
          const chunks = row.id===rows[0].id ? scenario.sourceChunks : scenario.targetChunks;
          const revision = randomUUID().replaceAll('-','');
          const hash = fingerprintNoteSnapshot({ ...row, accountId });
          const sourceHash = digest([row.content,chunks]);
          await tx.execute({ sql: 'INSERT INTO blinko_ps_heads(account_id,note_id,epoch,tombstone) VALUES(?,?,1,0)', args: [accountId,row.id] });
          await tx.execute({ sql: `INSERT INTO blinko_ps_revisions(revision_id,account_id,note_id,generation,snapshot_hash,source_hash,chunk_count,epoch,state,provenance,old_revisions,created_at,expires_at) VALUES(?,?,?,?,?,?,?,1,'published','verified','[]',?,?)`,
            args: [revision,accountId,row.id,generation.generation,hash,sourceHash,chunks,date.toISOString(),date.toISOString()] });
          for (let ordinal=0; ordinal<chunks; ordinal++) {
            const metadata = { accountId,id:row.id,noteId:row.id,revisionId:revision,noteSnapshotHash:hash,sourceHash,
              sourceKind:'body',chunkOrdinal:ordinal,chunkCount:chunks,embeddingSpaceId:generation.embeddingSpaceId,
              generation:generation.generation,text:row.content+` chunk ${ordinal}` };
            await tx.execute({ sql: `INSERT INTO ${indexTable(generation.tableName)}(vector_id,embedding,metadata) VALUES(?,?,?)`,
              args: [`${revision}:${ordinal}`,blobs[ordinal],JSON.stringify(metadata)] });
          }
        }
        await tx.commit();
      } finally { await tx.close(); }
    }
    await client.execute({ sql: 'INSERT INTO blinko_ps_corpora(account_id,generation,revision) VALUES(?,?,?)', args: [accountId,generation.generation,randomUUID()] });
    await lifecycle.activateGeneration(generation.generation);
    return { ...scenario,accountId,url,sourceId:rows[0].id,excludeIds:rows.slice(1,scenario.explicitExclusions+1).map(row=>row.id) };
  } finally { client.close(); }
}

if (process.argv[2] === '--query') {
  await measure(JSON.parse(readFileSync(process.argv[3], 'utf8')), process.argv[4]);
} else {
  const output = process.argv[2];
  if (!output) throw new Error('Provide unused JSON output path');
  const prisma = new PrismaClient();
  const runs: unknown[] = [];
  try {
    for (const [index, scenario] of scenarios.entries()) {
      const folder = path.join(path.dirname(output), `resource-case-${index}`);
      console.log(JSON.stringify({ seeding: scenario }));
      const fixture = await seed(prisma,scenario,folder);
      try {
        const fixtureFile=path.join(folder,'fixture.json'), resultFile=path.join(folder,'measurements.json');
        writeFileSync(fixtureFile,JSON.stringify(fixture),{flag:'wx'});
        const child=Bun.spawn([process.execPath,'run',fileURLToPath(import.meta.url),'--query',fixtureFile,resultFile],
          {env:process.env,stdout:'pipe',stderr:'pipe'});
        const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
        writeFileSync(path.join(folder,'query.log'),stdout+stderr,{flag:'wx'});
        if(code!==0) throw new Error(`Resource query child exited ${code}; see ${folder}/query.log`);
        const result=JSON.parse(readFileSync(resultFile,'utf8'));
        runs.push(result);
        console.log(JSON.stringify({notes:result.notes,targetChunks:result.targetChunks,sourceChunks:result.sourceChunks,
          excludedRatio:result.explicitExcludedRatio,peakRssBytes:result.memory.observedPeakRssBytes,
          warmP95Ms:result.warmP95Ms,retrieval:result.samples.at(-1).retrieval}));
      } finally {
        await prisma.notes.deleteMany({where:{accountId:fixture.accountId}});
        await prisma.pluginServiceRate.deleteMany({where:{accountId:fixture.accountId}});
        await prisma.accounts.delete({where:{id:fixture.accountId}});
      }
    }
    writeFileSync(output,JSON.stringify({at:new Date().toISOString(),cpu:cpus()[0]?.model,cpuCount:cpus().length,
      os:release(),platform:process.platform,bun:Bun.version,runtime:process.version,dimensions,budget:VECTOR_QUERY_BUDGET,
      externalProviderCalls:0,cache:'First and subsequent warm queries; each query opens a reader; OS caches not cleared.',
      boundary:'Instrumented service boundary: SQL, LibSQL reads, rate gate, scoring and assembly. No HTTP/SDK/browser or external embedding. RSS sampling overhead is included. Descriptive samples, not a production SLO.',runs},null,2)+'\n',{flag:'wx'});
  } finally { await prisma.$disconnect(); }
}
