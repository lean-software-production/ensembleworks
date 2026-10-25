import { afterEach, expect, it, vi } from 'vitest';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from '../server';
import { Hub } from '../src/hub';
import type { ConversationWatch } from '../src/domain';

const hosts: ReturnType<typeof createFakePluginHost>[]=[];
async function setup() {
  const h=createFakePluginHost({sdk:{threads:{get:async ({threadId})=>makeThreadResponse({id:threadId,status:'idle'}),send:async()=>({delivery:'sent' as const})}}});
  hosts.push(h); await plugin(h.bb); return h;
}
afterEach(async()=>{for(const h of hosts.splice(0))await h.harness.lifecycle.dispose();vi.useRealTimers();});
async function attach(h:ReturnType<typeof createFakePluginHost>) {
  const c=await h.harness.behavior.callRpc('transcripts.import',{title:'Planning',format:'txt',text:'Alex: First idea.\n\nSam: Second idea.'}) as {id:string};
  await h.harness.behavior.callRpc('attachments.set',{threadId:'A',conversationId:c.id});
  return c;
}
it('exposes explicit start/status/stop and keeps ordinary acknowledgement independent',async()=>{
  const h=await setup(), c=await attach(h), {harness}=h;
  const w=await harness.behavior.callRpc('watch.start',{threadId:'A'}) as ConversationWatch;
  expect(w).toMatchObject({threadId:'A',conversationId:c.id,processedCursor:0});
  await harness.behavior.callAgentTool('communications_acknowledge',{conversationId:c.id,cursor:2},{threadId:'A'});
  await harness.behavior.callAgentTool('communications_read',{},{threadId:'A'});
  expect(JSON.parse(await harness.behavior.callAgentTool('communications_watch_status',{},{threadId:'A'}) as string)).toMatchObject({watch:{processedCursor:0,generation:w.generation}});
  expect(await harness.behavior.callAgentTool('communications_watch_acknowledge',{conversationId:c.id,generation:w.generation,cursor:1},{threadId:'B'})).toMatchObject({isError:true});
  expect(JSON.parse(await harness.behavior.callAgentTool('communications_watch_acknowledge',{conversationId:c.id,generation:w.generation,cursor:1},{threadId:'A'}) as string)).toMatchObject({processedCursor:1});
  expect(await harness.behavior.callRpc('attachments.get',{threadId:'A'})).toMatchObject({attachment:{cursor:2}});
  await harness.behavior.callRpc('watch.stop',{threadId:'A'});
  expect(await harness.behavior.callRpc('watch.get',{threadId:'A'})).toEqual({watch:null});
  const restarted=await harness.behavior.callRpc('watch.start',{threadId:'A'}) as ConversationWatch;
  expect(restarted.generation).not.toBe(w.generation);
  expect(await harness.behavior.callAgentTool('communications_watch_acknowledge',{conversationId:c.id,generation:w.generation,cursor:2},{threadId:'A'})).toMatchObject({isError:true});
});
it('supports CLI lifecycle and processing acknowledgement across reload',async()=>{
  const h=await setup(), c=await attach(h);
  const start=await h.harness.behavior.runCli(['watch-start','A']);expect(start.exitCode).toBe(0);
  const w=JSON.parse(start.stdout) as ConversationWatch;
  expect((await h.harness.behavior.runCli(['watch-acknowledge',c.id,w.generation,'1','A'])).exitCode).toBe(0);
  const replacement=await h.harness.lifecycle.reload(plugin);hosts.push(replacement);
  const status=await replacement.harness.behavior.runCli(['watch-status','A']);
  expect(JSON.parse(status.stdout)).toMatchObject({watch:{generation:w.generation,processedCursor:1}});
  expect((await replacement.harness.behavior.runCli(['watch-stop','A'])).exitCode).toBe(0);
  expect((await replacement.harness.behavior.runCli(['watch-start','A','unexpected'])).exitCode).toBe(1);
  expect((await replacement.harness.behavior.runCli(['watch-acknowledge',c.id,w.generation,'999','A'])).exitCode).toBe(1);
});
it('rejects absent attachment and archived thread; deletion stops the watch',async()=>{
  const h=await setup();
  await expect(h.harness.behavior.callRpc('watch.start',{threadId:'A'})).rejects.toThrow();
  await attach(h);
  h.harness.sdk.stub('threads.get',async ({threadId})=>makeThreadResponse({id:threadId,archivedAt:1}));
  await expect(h.harness.behavior.callRpc('watch.start',{threadId:'A'})).rejects.toThrow(/Unarchive/);
  h.harness.sdk.stub('threads.get',async ({threadId})=>makeThreadResponse({id:threadId,status:'idle'}));
  await h.harness.behavior.callRpc('watch.start',{threadId:'A'});
  await h.harness.behavior.emitThreadEvent('thread.deleted',{thread:makeThreadResponse({id:'A'})});
  expect(await h.harness.behavior.callRpc('watch.get',{threadId:'A'})).toEqual({watch:null});
});
it('delivers a generic wake via hub changes and stops after processing',async()=>{
  vi.useFakeTimers();
  const h=await setup(),c=await attach(h);
  const w=await h.harness.behavior.callRpc('watch.start',{threadId:'A'}) as ConversationWatch;
  await vi.advanceTimersByTimeAsync(15_000);
  const sends=h.harness.inspection.sdk.callsTo('threads.send');
  expect(sends).toHaveLength(1);
  const serialized=JSON.stringify(sends[0]);
  expect(serialized).toContain(c.id);expect(serialized).toContain(w.generation);
  expect(serialized).not.toContain('First idea');expect(serialized).not.toContain('mind map');
  await h.harness.behavior.callAgentTool('communications_watch_acknowledge',{conversationId:c.id,generation:w.generation,cursor:2},{threadId:'A'});
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(1);
});

it('recovers newly stored passages without a poke using the real service and SQLite',async()=>{
  vi.useFakeTimers();
  const h=await setup(),c=await attach(h);
  const w=await h.harness.behavior.callRpc('watch.start',{threadId:'A'}) as ConversationWatch;
  await h.harness.behavior.callAgentTool('communications_watch_acknowledge',{conversationId:c.id,generation:w.generation,cursor:2},{threadId:'A'});
  const service=h.harness.behavior.runService('conversation-watch-dispatcher');
  await vi.advanceTimersByTimeAsync(15_000);
  expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(0);
  // The second Hub shares durable state but has no changed callback: intentionally drop the poke.
  const withoutPokes=new Hub(h.bb.storage.database());
  withoutPokes.appendSegments(c.id,[{sourceKey:'late',speaker:null,text:'New speech after startup',startMs:0,endMs:null}]);
  await vi.advanceTimersByTimeAsync(45_000);
  expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(1);
  expect(withoutPokes.getWatch('A')!.processedCursor).toBe(2);
  service.controller.abort();await service.done;
});
it('retains passages while busy and suppresses concurrent duplicate dispatch',async()=>{
  vi.useFakeTimers();
  const h=await setup(),c=await attach(h);
  h.harness.sdk.stub('threads.get',async ({threadId})=>makeThreadResponse({id:threadId,status:'active'}));
  await h.harness.behavior.callRpc('watch.start',{threadId:'A'});
  await vi.advanceTimersByTimeAsync(15_000);
  expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(0);
  const hub=new Hub(h.bb.storage.database());
  hub.appendSegments(c.id,[{sourceKey:'during-turn',speaker:null,text:'Speech during work',startMs:null,endMs:null}]);
  h.harness.sdk.stub('threads.get',async ({threadId})=>makeThreadResponse({id:threadId,status:'idle'}));
  await h.harness.behavior.emitThreadEvent('thread.idle',{thread:makeThreadResponse({id:'A',status:'idle'}),lastAssistantText:'Done'});
  await h.harness.behavior.emitThreadEvent('thread.idle',{thread:makeThreadResponse({id:'A',status:'idle'}),lastAssistantText:'Done'});
  await vi.advanceTimersByTimeAsync(15_000);
  expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(1);
  expect(hub.getWatch('A')!.processedCursor).toBe(0);
  expect(hub.latestSequence(c.id)).toBe(3);
});
it('does not send when stopped during an in-flight thread lookup',async()=>{
  vi.useFakeTimers();
  const h=await setup();await attach(h);
  await h.harness.behavior.callRpc('watch.start',{threadId:'A'});
  let release!:(value:ReturnType<typeof makeThreadResponse>)=>void;
  h.harness.sdk.stub('threads.get',()=>new Promise(resolve=>{release=resolve;}));
  await vi.advanceTimersByTimeAsync(15_000);
  expect(release).toBeTypeOf('function');
  await h.harness.behavior.callRpc('watch.stop',{threadId:'A'});
  release(makeThreadResponse({id:'A',status:'idle'}));
  await vi.advanceTimersByTimeAsync(0);
  expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(0);
});

it('a stop cancels a start still awaiting thread validation',async()=>{
  const h=await setup();await attach(h);
  let release!:(value:ReturnType<typeof makeThreadResponse>)=>void;
  h.harness.sdk.stub('threads.get',()=>new Promise(resolve=>{release=resolve;}));
  const starting=h.harness.behavior.callRpc('watch.start',{threadId:'A'});
  const rejected=expect(starting).rejects.toThrow(/cancelled/);
  await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  await h.harness.behavior.callRpc('watch.stop',{threadId:'A'});
  release(makeThreadResponse({id:'A',status:'idle'}));
  await rejected;
  expect(await h.harness.behavior.callRpc('watch.get',{threadId:'A'})).toEqual({watch:null});
});
