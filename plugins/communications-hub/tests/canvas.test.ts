import { afterEach, expect, it } from 'vitest';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from '../server';
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });
const entry = (id:number, text:string, ts=1000) => ({ id, text, ts, speaker:'Alex' });
async function setup(rows = [entry(1, 'First'), entry(2, 'Second')]) {
  const host = createFakePluginHost({sdk:{threads:{get:async ({threadId})=>makeThreadResponse({id:threadId})}}});
  hosts.push(host);
  let fail = false;
  let streamId = 'stream-a';
  const wire = (target: typeof host) => target.harness.inspection.sdk.stub('plugins.callRpc', async ({input}) => {
    if (fail) throw new Error('private source response must not escape');
    const after = (input as {after:number}).after;
    const entries = rows.filter(row => row.id > after).slice(0,100);
    return {streamId, entries, nextCursor:entries.at(-1)?.id ?? after, hasMore:rows.some(row=>row.id > (entries.at(-1)?.id ?? after))};
  });
  wire(host);
  await plugin(host.bb);
  return {host, rows, wire, fail:()=>{fail=true;}, reset:()=>{streamId='different';}};
}
async function start(host:ReturnType<typeof createFakePluginHost>) {
  const result = await host.harness.behavior.runCli(['canvas-start','Team conversation']);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout).conversationId as string;
}
async function tick(host:ReturnType<typeof createFakePluginHost>, until:()=>Promise<boolean>) {
  const service = host.harness.behavior.runService('canvas-transcript');
  try { await expect.poll(until).toBe(true); }
  finally { service.controller.abort(); await service.done; }
}
it('imports retained speech, splits long entries, and exposes the normal tools with independent cursors',async()=>{
  const {host}=await setup([entry(1,'x'.repeat(4001)),entry(2,'Late speech',500)]);
  const id=await start(host);
  const page=await host.harness.behavior.callRpc('transcripts.read',{conversationId:id}) as {segments:{text:string;startMs:number|null}[]};
  expect(page.segments.map(s=>s.text.length)).toEqual([2000,2000,1,11]);
  expect(page.segments.at(-1)?.startMs).toBeNull();
  for(const threadId of ['A','B']) await host.harness.behavior.callRpc('attachments.set',{threadId,conversationId:id});
  await host.harness.behavior.callAgentTool('communications_acknowledge',{conversationId:id,cursor:1},{threadId:'A'});
  expect(await host.harness.behavior.callRpc('attachments.get',{threadId:'B'})).toMatchObject({attachment:{cursor:0}});
  const read=JSON.parse(await host.harness.behavior.callAgentTool('communications_read',{}, {threadId:'B'}) as string);
  expect(read.citations.base).toContain(id);
  expect(await start(host)).toBe(id);
});
it('resumes after reload, deduplicates replay after a checkpoint loss, and persists Stop capture',async()=>{
  const {host,rows,wire}=await setup(); const id=await start(host);
  const saved=await host.bb.storage.kv.get<Record<string,unknown>>('canvas:capture');
  await host.bb.storage.kv.set('canvas:capture',{...saved,cursor:0});
  const next=await host.harness.lifecycle.reload(plugin); hosts.push(next); wire(next);
  rows.push(entry(3,'New speech'));
  await tick(next,async()=> (await next.harness.behavior.callRpc('conversations.get',{conversationId:id}) as {segmentCount:number}).segmentCount===3);
  await next.harness.behavior.callRpc('capture.stop',{conversationId:id});
  rows.push(entry(4,'After stop'));
  const stopped=await next.harness.lifecycle.reload(plugin); hosts.push(stopped);
  expect(await stopped.harness.behavior.callRpc('sources.status')).toMatchObject({canvas:{enabled:false,cursor:3}});
  expect(await stopped.harness.behavior.callRpc('conversations.get',{conversationId:id})).toMatchObject({segmentCount:3,captureState:'stopped'});
});
it('reports a source outage without advancing progress or exposing transcript/error contents',async()=>{
  const {host,fail}=await setup(); const id=await start(host); fail();
  await tick(host,async()=> (await host.harness.behavior.callRpc('conversations.get',{conversationId:id}) as {captureState:string}).captureState==='interrupted');
  const status=await host.harness.behavior.callRpc('sources.status');
  expect(status).toMatchObject({canvas:{cursor:2}});
  expect(JSON.stringify(await host.harness.behavior.callRpc('conversations.get',{conversationId:id}))).not.toContain('private source');
});
it('refuses to mix a replaced source database into an existing conversation',async()=>{
  const {host,reset,rows}=await setup(); const id=await start(host); reset(); rows.push(entry(3,'Wrong database'));
  await tick(host,async()=> (await host.harness.behavior.callRpc('conversations.get',{conversationId:id}) as {captureState:string}).captureState==='interrupted');
  expect(await host.harness.behavior.callRpc('conversations.get',{conversationId:id})).toMatchObject({segmentCount:2});
});
it('drains more than one bounded page without skipping backlog',async()=>{
  const {host}=await setup(Array.from({length:205},(_,i)=>entry(i+1,`Speech ${i}`)));
  const id=await start(host);
  await tick(host,async()=> (await host.harness.behavior.callRpc('conversations.get',{conversationId:id}) as {segmentCount:number}).segmentCount===205);
});
