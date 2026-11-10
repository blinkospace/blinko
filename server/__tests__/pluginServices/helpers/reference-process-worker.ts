import { createClient, type Client, type Transaction } from '@libsql/client';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { VectorSnapshotStore } from '../../../services/pluginServices/VectorSnapshotStore';
import { IndexLifecycle } from '../../../services/pluginServices/IndexLifecycle';
const [mode, specPath] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
if (process.env.B_CANDIDATE_PROBE !== '1' || !spec.url.startsWith('file:') || !spec.url.includes('/blinko-reference-process-')) throw Error('Synthetic reference process fixture required');
const crash = () => { writeFileSync(specPath + '.exit.json', JSON.stringify({ mode, pid: process.pid, exit: 86 })); process.exit(86); };
const client = createClient({ url: spec.url });
await client.execute('PRAGMA foreign_keys=ON');
let armed = false;
const pattern = mode.startsWith('refs-') ? /INSERT INTO blinko_ps_snapshot_refs/ : mode.startsWith('ready-') ? /UPDATE blinko_ps_snapshots SET state='ready'/ : mode.startsWith('release-') ? /DELETE FROM blinko_ps_snapshots/ : /UPDATE blinko_ps_revisions SET state='staged'/;
const wrapped = new Proxy(client, { get(target, key) {
  if (key === 'transaction') return async (...args: any[]) => {
    const tx = await (target.transaction as Function).apply(target, args);
    return new Proxy(tx, { get(transaction, property) {
      if (property === 'execute') return async (...values: any[]) => {
        const sql = typeof values[0] === 'string' ? values[0] : values[0].sql;
        const result = await (transaction.execute as Function).apply(transaction, values);
        if (pattern.test(sql)) armed = true;
        return result;
      };
      if (property === 'commit') return async () => {
        if (armed && mode.endsWith('before')) crash();
        await transaction.commit();
        if (armed && mode.endsWith('after')) crash();
      };
      const value = Reflect.get(transaction, property); return typeof value === 'function' ? value.bind(transaction) : value;
    } });
  };
  const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
} }) as Client;
const store = new VectorSnapshotStore(wrapped, () => spec.now);
try {
  if (mode === 'quota') {
    writeFileSync(specPath + '.ready', 'ready');
    const deadline = performance.now() + 5000;
    while (!existsSync(resolve(dirname(specPath), 'go'))) { if (performance.now() > deadline) throw Error('barrier timeout'); await Bun.sleep(5); }
    try { console.log(JSON.stringify({ status: 'reserved', handle: await store.reserve(spec.accountId) })); }
    catch (error) { if ((error as any).code !== 'QUERY_BUDGET_EXCEEDED') throw error; console.log(JSON.stringify({ status: 'rejected', code: (error as any).code })); }
  } else if (mode === 'reserve-after') {
    const handle = await store.reserve(spec.accountId); writeFileSync(specPath + '.handle.json', JSON.stringify({ handle })); crash();
  } else if (mode.startsWith('refs-')) await store.addReferences(spec.handle, spec.accountId, spec.members);
  else if (mode.startsWith('ready-')) await store.publish(spec.accountId, spec.envelope);
  else if (mode.startsWith('release-')) await store.release(spec.accountId, spec.handle);
  else if (mode.startsWith('stage-')) {
    const lifecycle = new IndexLifecycle(wrapped, { async readNote() { throw Error('Stage transaction must not await PostgreSQL'); } }, () => new Date(spec.now));
    await lifecycle.stageRevision(spec.lease, spec.generation, spec.body, spec.vectors, 'verified', spec.witness);
  } else throw Error('Unknown worker mode');
} finally { client.close(); }
