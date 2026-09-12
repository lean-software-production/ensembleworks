import { afterEach, expect, it } from 'vitest';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { Hub } from '../src/hub';
import { registerEnsembleWorks, transcriptUrl } from '../src/adapters/ensembleworks';
const hosts: ReturnType<typeof createFakePluginHost>[]=[];
afterEach(async()=>{for(const host of hosts.splice(0)) await host.harness.lifecycle.dispose();});
const row=(id:string,t:number,text='Speech')=>({id,t,text,identity:'livekit:alice',name:'Alice'});
async function setup() {
  const host=createFakePluginHost(); hosts.push(host);
  let rows=[row('a',100000),row('b',100000,'x'.repeat(4000))];
  let fail=false;
  const requests:URL[]=[];
  const request:typeof fetch=async(input)=>{
    const url=new URL(String(input)); requests.push(url);
    if(fail) return new Response('private details',{status:503});
    const since=Number(url.searchParams.get('since'));
    return Response.json({ok:true,now:200000,entries:rows.filter(r=>r.t>since).slice(-10000)});
  };
  let hub:Hub;
  let adapter:Awaited<ReturnType<typeof registerEnsembleWorks>>;
  const factory=async(bb:typeof host.bb)=>{hub=new Hub(bb.storage.database());adapter=await registerEnsembleWorks(bb,hub,request);};
  await factory(host.bb);
  return {host,requests,factory,hub:()=>hub!,adapter:()=>adapter!,setRows:(r:typeof rows)=>{rows=r;},fail:()=>{fail=true;}};
}
async function tick(host:ReturnType<typeof createFakePluginHost>,until:()=>boolean) {
  const service=host.harness.behavior.runService('ensembleworks-transcript');
  try {await expect.poll(until).toBe(true);} finally {service.controller.abort();await service.done;}
}
it('maps V1 identity and timings, handles tied timestamps and late overlap without duplication after reload',async()=>{
  const s=await setup();const {conversationId}=await s.adapter().start('http://localhost:8788','team','Team',0);
  expect(s.hub().getConversation(conversationId).segmentCount).toBe(3);
  expect(s.hub().readTranscript(conversationId,{}).segments[0]).toMatchObject({speaker:'Alice',speakerId:'livekit:alice',startMs:100000,endMs:null});
  s.setRows([row('a',100000),row('b',100000,'x'.repeat(4000)),row('late',90000),row('new',120000)]);
  const next=await s.host.harness.lifecycle.reload(s.factory);hosts.push(next);
  await tick(next,()=>s.hub().getConversation(conversationId).segmentCount===5);
  expect(s.requests.at(-1)?.searchParams.get('since')).toBe('40000');
  s.hub().attach('A',conversationId);s.hub().attach('B',conversationId);s.hub().acknowledge('A',conversationId,2);
  expect(s.hub().getAttachment('B')?.cursor).toBe(0);
  await s.adapter().stop(conversationId);
  expect(s.hub().getConversation(conversationId).captureState).toBe('stopped');
  const stopped=await next.harness.lifecycle.reload(s.factory);hosts.push(stopped);
  expect(s.adapter().status().enabled).toBe(false);
});
it('retains progress and marks interruption when a tail is saturated or HTTP fails',async()=>{
  const s=await setup();const {conversationId}=await s.adapter().start('http://localhost:8788','team','Team',0);
  s.setRows(Array.from({length:10000},(_,i)=>row(String(i),110000+i)));
  await tick(s.host,()=>s.hub().getConversation(conversationId).captureState==='interrupted');
  expect(s.hub().getConversation(conversationId).segmentCount).toBe(3);
  expect(await s.host.bb.storage.kv.get('ensembleworks:capture')).toMatchObject({since:100000});
  s.fail();
  await tick(s.host,()=>s.requests.length>=3);
  expect(s.hub().getConversation(conversationId).captureDetail).not.toContain('private');
});
it('validates source URLs and rejects switching an enabled capture',async()=>{
  expect(()=>transcriptUrl('file:///tmp/transcript','team',0)).toThrow();
  expect(()=>transcriptUrl('https://user:secret@example.com','team',0)).toThrow();
  const s=await setup();await s.adapter().start('http://localhost:8788','team','Team',0);
  await expect(s.adapter().start('http://localhost:8788','another','Another',0)).rejects.toThrow('Stop');
});
it('cancels an in-flight source request on disposal',async()=>{
  const host=createFakePluginHost();hosts.push(host);const hub=new Hub(host.bb.storage.database());
  let began=false;let aborted=false;
  const adapter=await registerEnsembleWorks(host.bb,hub,async(_input,init)=>new Promise((_resolve,reject)=>{
    began=true;init!.signal!.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));},{once:true});
  }));
  const start=adapter.start('http://localhost:8788','team','Team',0);
  await expect.poll(()=>began).toBe(true);
  await host.harness.lifecycle.dispose();await start;
  expect(aborted).toBe(true);
});
