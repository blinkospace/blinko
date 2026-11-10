import { afterAll, afterEach, expect, test } from 'bun:test';
import { PrismaClient } from '@prisma/client';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { PaidCallSpec } from '../../services/pluginServices/CallPolicy';
if(process.env.PLUGIN_SERVICES_TEST_DB!=='1' || !process.env.DATABASE_URL) throw new Error('Dedicated PG required');
const db = new URL(process.env.DATABASE_URL);
if(db.hostname!=='127.0.0.1' || db.username!=='blinko_test') throw new Error('Wrong database');
const prisma = new PrismaClient();
const accounts:number[]=[];
const peers:Peer[]=[];
type Message = {type:string;id?:string;pid:number;ok?:boolean;code?:string;allowed?:boolean;requestId?:string};
class Peer {
  child:ChildProcessWithoutNullStreams;
  messages:Message[]=[];
  waits:Array<{match:(value:Message)=>boolean;resolve:(value:Message)=>void;reject:(error:Error)=>void}>=[];
  stderr='';
  stopped:Promise<void>;
  pid=0;
  constructor(){
    this.child=spawn(process.execPath,['run',fileURLToPath(new URL('./helpers/ledgerProcessWorker.ts',import.meta.url))],{env:process.env,stdio:['pipe','pipe','pipe']});
    this.child.stderr.on('data',data=>{this.stderr=(this.stderr+String(data)).slice(-3000);});
    createInterface({input:this.child.stdout}).on('line',line=>{
      const value=JSON.parse(line) as Message;
      const index=this.waits.findIndex(wait=>wait.match(value));
      if(index<0) this.messages.push(value);
      else this.waits.splice(index,1)[0].resolve(value);
    });
    this.stopped=new Promise(resolve=>this.child.once('exit',()=>{
      for(const wait of this.waits.splice(0)) wait.reject(new Error('Peer exited: '+this.stderr));
      resolve();
    }));
    peers.push(this);
  }
  send(value:unknown){this.child.stdin.write(JSON.stringify(value)+'\n');}
  take(match:(value:Message)=>boolean):Promise<Message>{
    const index=this.messages.findIndex(match);
    if(index>=0) return Promise.resolve(this.messages.splice(index,1)[0]);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.waits=this.waits.filter(wait=>wait!==entry);reject(new Error('Peer deadline: '+this.stderr));},12000);
      const entry={match,resolve:(value:Message)=>{clearTimeout(timer);resolve(value);},reject:(error:Error)=>{clearTimeout(timer);reject(error);}};
      this.waits.push(entry);
    });
  }
  async ready(){this.pid=(await this.take(value=>value.type==='ready')).pid;return this;}
  result(id:string){return this.take(value=>value.id===id && value.type==='result');}
  transition(id:string){return this.take(value=>value.id===id && ['entered','result'].includes(value.type));}
  kill(){if(this.child.exitCode===null && this.child.signalCode===null)this.child.kill('SIGKILL');return this.stopped;}
}
async function workers(count:number){
  const values=await Promise.all(Array.from({length:count},()=>new Peer().ready()));
  expect(new Set(values.map(value=>value.pid)).size).toBe(count);
  expect(values.every(value=>value.pid!==process.pid)).toBe(true);
  console.log(JSON.stringify({parentPid:process.pid,workerPids:values.map(value=>value.pid),workerConnectionLimit:1}));
  return values;
}
async function base(extra:Partial<PaidCallSpec>={}):Promise<PaidCallSpec>{
  const accountId=(await prisma.accounts.create({data:{name:'synthetic-process-ledger-'+crypto.randomUUID()}})).id;
  accounts.push(accountId);
  return {accountId,operation:'ai.generateText',idempotencyKey:crypto.randomUUID(),requestFingerprint:'synthetic-process-input',modelId:1,
    reservedTokens:20,maxOutputTokens:10,timeoutMs:20000,dailyTokenLimit:100,maxConcurrent:2,maxRequestsPerMinute:240,...extra};
}
async function totals(accountId:number){return prisma.pluginServiceDailyUsage.findFirstOrThrow({where:{accountId}});}
afterEach(async()=>{await Promise.all(peers.splice(0).map(peer=>peer.kill()));});
afterAll(async()=>{
  for(const accountId of accounts){
    await prisma.pluginServiceRequests.deleteMany({where:{accountId}});
    await prisma.pluginServiceDailyUsage.deleteMany({where:{accountId}});
    await prisma.pluginServiceRate.deleteMany({where:{accountId}});
    await prisma.accounts.delete({where:{id:accountId}});
  }
  await prisma.$disconnect();
});

test('six independent processes racing one empty idempotency key dispatch and settle exactly once',async()=>{
  const spec=await base();
  const group=await workers(6);
  for(const peer of group) peer.send({type:'run',id:'race',spec,hold:true});
  const transitions=await Promise.all(group.map(peer=>peer.transition('race')));
  const admitted=transitions.map((value,index)=>({value,peer:group[index]})).filter(item=>item.value.type==='entered');
  expect(admitted).toHaveLength(1);
  expect(transitions.filter(value=>value.type==='result').every(value=>!value.ok && value.code==='REQUEST_IN_PROGRESS')).toBe(true);
  expect(await prisma.pluginServiceRequests.count({where:{accountId:spec.accountId}})).toBe(1);
  admitted[0].peer.send({type:'release',id:'race'});
  expect((await admitted[0].peer.result('race')).ok).toBe(true);
  const replay=group.find(peer=>peer!==admitted[0].peer)!;
  replay.send({type:'run',id:'replay',spec,hold:false});
  expect(await replay.result('replay')).toMatchObject({ok:false,code:'RESULT_NOT_RETAINED'});
  expect(await totals(spec.accountId)).toMatchObject({reservedTokens:0,settledTokens:7});
},30000);

test('four independent processes cannot exceed two account concurrency slots',async()=>{
  const spec=await base();
  const group=await workers(4);
  group.forEach((peer,index)=>peer.send({type:'run',id:'cap',spec:{...spec,idempotencyKey:'cap-'+index},hold:true}));
  const transitions=await Promise.all(group.map(peer=>peer.transition('cap')));
  const admitted=group.filter((_peer,index)=>transitions[index].type==='entered');
  expect(admitted).toHaveLength(2);
  expect(transitions.filter(value=>value.type==='result').every(value=>!value.ok && value.code==='RATE_LIMITED')).toBe(true);
  expect(await prisma.pluginServiceRequests.count({where:{accountId:spec.accountId,state:{in:['reserved','dispatched']}}})).toBe(2);
  for(const peer of admitted) peer.send({type:'release',id:'cap'});
  expect((await Promise.all(admitted.map(peer=>peer.result('cap')))).every(value=>value.ok)).toBe(true);
  expect(await totals(spec.accountId)).toMatchObject({reservedTokens:0,settledTokens:14});
},30000);

test('four processes share the durable daily budget before invoking a generator',async()=>{
  const spec=await base({reservedTokens:60,maxConcurrent:4});
  const group=await workers(4);
  group.forEach((peer,index)=>peer.send({type:'run',id:'budget',spec:{...spec,idempotencyKey:'budget-'+index},hold:true}));
  const transitions=await Promise.all(group.map(peer=>peer.transition('budget')));
  const admitted=group.filter((_peer,index)=>transitions[index].type==='entered');
  expect(admitted).toHaveLength(1);
  expect(transitions.filter(value=>value.type==='result').every(value=>!value.ok && value.code==='BUDGET_EXCEEDED')).toBe(true);
  expect(await totals(spec.accountId)).toMatchObject({reservedTokens:60,settledTokens:0});
  const rates=await prisma.pluginServiceRate.findMany({where:{accountId:spec.accountId}});
  expect(rates.reduce((sum,row)=>sum+row.used,0)).toBe(1);
  admitted[0].send({type:'release',id:'budget'});
  expect((await admitted[0].result('budget')).ok).toBe(true);
  expect(await totals(spec.accountId)).toMatchObject({reservedTokens:0,settledTokens:7});
},30000);

test('eight independent processes atomically share a three-request rate window',async()=>{
  const spec=await base();
  const group=await workers(8);
  for(const peer of group) peer.send({type:'rate',id:'rate',accountId:spec.accountId,limit:3});
  const results=await Promise.all(group.map(peer=>peer.result('rate')));
  expect(results.every(value=>value.ok)).toBe(true);
  const admitted=results.filter(value=>value.allowed).length;
  const rows=await prisma.pluginServiceRate.findMany({where:{accountId:spec.accountId}});
  expect(admitted).toBeGreaterThanOrEqual(3);
  expect(rows.every(row=>row.used<=3)).toBe(true);
  expect(rows.reduce((sum,row)=>sum+row.used,0)).toBe(admitted);
  if(rows.length===1) expect(admitted).toBe(3);
  console.log(JSON.stringify({rateWindowCounts:rows.map(row=>({windowStart:row.windowStart,used:row.used})),admitted}));
},30000);

test('another process recovers a killed dispatched owner without a duplicate invocation',async()=>{
  const spec=await base({maxConcurrent:1});
  const [owner,recovery]=await workers(2);
  owner.send({type:'run',id:'crash',spec,hold:true});
  const entered=await owner.transition('crash');
  expect(entered.type).toBe('entered');
  await owner.kill();
  await prisma.pluginServiceRequests.update({where:{requestId:entered.requestId!},data:{deadlineAt:new Date(Date.now()-60000)}});
  recovery.send({type:'run',id:'old-key',spec,hold:false});
  expect(await recovery.result('old-key')).toMatchObject({ok:false,code:'OUTCOME_UNKNOWN'});
  expect(recovery.messages.filter(value=>value.type==='entered' && value.id==='old-key')).toHaveLength(0);
  recovery.send({type:'run',id:'new-key',spec:{...spec,idempotencyKey:'after-crash'},hold:false});
  expect((await recovery.result('new-key')).ok).toBe(true);
  expect(await totals(spec.accountId)).toMatchObject({reservedTokens:20,settledTokens:7});
  expect((await prisma.pluginServiceRequests.findUniqueOrThrow({where:{requestId:entered.requestId!}})).state).toBe('outcome_unknown');
},30000);

test('eight independent processes atomically share split p=3/r=2 admission', async () => {
  const [clock] = await prisma.$queryRaw<Array<{ remaining: number }>>`SELECT EXTRACT(EPOCH FROM date_trunc('minute',clock_timestamp())+interval '1 minute'-clock_timestamp())::float8 AS remaining`;
  if (clock.remaining < 6) await new Promise(resolve => setTimeout(resolve, Math.ceil(clock.remaining * 1000) + 100));
  const spec = await base(), group = await workers(8);
  group.forEach((peer, i) => peer.send({ type: 'rate', id: 'split', accountId: spec.accountId, limit: 3, options: { readNoteRequestsPerMinute: 2, lane: i < 4 ? 'shared' : 'readNote' } }));
  const results = await Promise.all(group.map(peer => peer.result('split')));
  expect(results.every(value => value.ok)).toBe(true);
  expect(results.filter(value => value.allowed)).toHaveLength(5);
  const rows = await prisma.pluginServiceRate.findMany({ where: { accountId: spec.accountId } });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ used: 5, sharedUsed: 3, readNoteUsed: 2 });
  console.log(JSON.stringify({ splitAcrossIndependentProcesses: { used: 5, sharedUsed: 3, readNoteUsed: 2 }, pids: group.map(peer => peer.pid) }));
}, 30000);
