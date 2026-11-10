// OS-process peer for db-ledger-process.test.ts; all responses are synthetic.
import { PrismaClient } from '@prisma/client';
import { createInterface } from 'node:readline';
import { createAccountRateGate, createCallPolicy, type PaidCallSpec } from '../../../services/pluginServices/CallPolicy';
if (process.env.PLUGIN_SERVICES_TEST_DB !== '1' || !process.env.DATABASE_URL) throw new Error('Dedicated PG required');
const url = new URL(process.env.DATABASE_URL);
if (url.hostname !== '127.0.0.1' || url.username !== 'blinko_test') throw new Error('Wrong database');
url.searchParams.set('connection_limit','1');
url.searchParams.set('pool_timeout','2');
const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
globalThis.fetch = Object.assign(async () => { throw new Error('External provider calls forbidden'); }, {
  preconnect() { throw new Error('External provider calls forbidden'); },
});
const policy = createCallPolicy({ prisma });
const releases = new Map<string,()=>void>();
const send = (message: Record<string,unknown>) => console.log(JSON.stringify({ ...message,pid:process.pid }));
const lines = createInterface({input:process.stdin});
lines.on('line', async line => {
  const message = JSON.parse(line);
  if (message.type==='release') { releases.get(message.id)?.(); return; }
  if (message.type==='close') { await prisma.$disconnect(); process.exit(0); }
  try {
    if (message.type==='rate') {
      const value = await createAccountRateGate({ prisma }).acquire(message.accountId,message.limit,message.options);
      send({type:'result',id:message.id,ok:true,allowed:value.allowed});
      return;
    }
    const spec = message.spec as PaidCallSpec;
    const result = await policy.runPaidOperation(spec,async context => {
      await context.markDispatched();
      const gate = new Promise<void>(resolve => releases.set(message.id,resolve));
      send({type:'entered',id:message.id,requestId:context.requestId});
      if (message.hold) await gate;
      releases.delete(message.id);
      return {result:'synthetic',usage:{inputTokens:4,outputTokens:3,status:'reported'}};
    });
    send({type:'result',id:message.id,ok:true,result});
  } catch (error) {
    send({type:'result',id:message.id,ok:false,code:(error as {code?:string}).code ?? 'UNEXPECTED'});
  }
});
send({type:'ready'});
