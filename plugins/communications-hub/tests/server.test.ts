import { afterEach, expect, it } from 'vitest';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from '../server';
const hosts: ReturnType<typeof createFakePluginHost>[]=[];
async function setup() { const h=createFakePluginHost({sdk:{threads:{get:async ({threadId})=>makeThreadResponse({id:threadId})}}}); hosts.push(h); await plugin(h.bb); return h; }
afterEach(async()=>{for(const h of hosts.splice(0)) await h.harness.lifecycle.dispose();});
const transcript={title:'Planning',format:'txt',text:'Alex: Add authentication.\n\nSam: Keep the import flow.'};
it('imports, attaches and resolves current conversation at tool execution time',async()=>{
 const {harness}=await setup();
 const first=await harness.behavior.callRpc('transcripts.import',transcript) as {id:string};
 const second=await harness.behavior.callRpc('transcripts.import',{...transcript,title:'Other'}) as {id:string};
 await harness.behavior.callRpc('attachments.set',{threadId:'A',conversationId:first.id});
 await harness.behavior.callRpc('attachments.set',{threadId:'B',conversationId:second.id});
 const current=JSON.parse(await harness.behavior.callAgentTool('communications_current',{}, {threadId:'A'}) as string);
 expect(current.conversation.id).toBe(first.id);
 await harness.behavior.callRpc('attachments.set',{threadId:'A',conversationId:second.id});
 const changed=JSON.parse(await harness.behavior.callAgentTool('communications_read',{}, {threadId:'A'}) as string);
 expect(changed.conversation.id).toBe(second.id); expect(changed.blocks[0].text).toBe('Add authentication.');
 expect(changed.speakers[changed.blocks[0].speaker]).toBe('Alex');
 expect(changed.citations.base).toContain(`/communications/${second.id}/`);
 expect(changed.citations.base+changed.blocks[0].citation).toContain(`/communications/${second.id}/1`);
 expect(JSON.stringify(changed)).not.toContain('sourceKey');
});
// Regression, 26 Nov 2026: the thread was re-attached from a finished meeting to a new one, the agent
// read the old ID it remembered, and told the room the meeting had ended. An explicit read of a
// conversation that is not attached still works, but now says which conversation is.
it('flags reads, searches and acknowledgements of a conversation the thread is no longer attached to',async()=>{
 const {harness}=await setup();
 const morning=await harness.behavior.callRpc('transcripts.import',{...transcript,title:'Morning'}) as {id:string};
 const afternoon=await harness.behavior.callRpc('transcripts.import',{...transcript,title:'Afternoon'}) as {id:string};
 await harness.behavior.callRpc('attachments.set',{threadId:'A',conversationId:morning.id});
 const before=JSON.parse(await harness.behavior.callAgentTool('communications_read',{conversationId:morning.id},{threadId:'A'}) as string);
 expect(before.attachmentWarning).toBeUndefined();
 await harness.behavior.callRpc('attachments.set',{threadId:'A',conversationId:afternoon.id});
 const stale=JSON.parse(await harness.behavior.callAgentTool('communications_read',{conversationId:morning.id},{threadId:'A'}) as string);
 expect(stale.conversation.id).toBe(morning.id);
 expect(Object.keys(stale).slice(0,2)).toEqual(['attachmentWarning','attachedConversationId']);
 expect(stale.attachedConversationId).toBe(afternoon.id);
 expect(stale.attachmentWarning).toBe(`Conversation ${morning.id} is not attached to this thread. This thread is attached to conversation ${afternoon.id} ("Afternoon", idle). Call communications_current before treating it as this thread’s meeting.`);
 const search=JSON.parse(await harness.behavior.callAgentTool('communications_search',{conversationId:morning.id,query:'authentication'},{threadId:'A'}) as string);
 expect(search.attachedConversationId).toBe(afternoon.id);
 const ack=await harness.behavior.callAgentTool('communications_acknowledge',{conversationId:morning.id,cursor:1},{threadId:'A'});
 expect(ack).toMatchObject({isError:true});
 expect(JSON.stringify(ack)).toContain(`This thread is attached to conversation ${afternoon.id} (\\"Afternoon\\", idle).`);
 const sinceAck=await harness.behavior.callAgentTool('communications_read',{conversationId:morning.id,sinceAcknowledged:true},{threadId:'A'});
 expect(JSON.stringify(sinceAck)).toContain(afternoon.id);
 const attached=JSON.parse(await harness.behavior.callAgentTool('communications_read',{conversationId:afternoon.id},{threadId:'A'}) as string);
 expect(attached.attachmentWarning).toBeUndefined(); expect(attached.attachedConversationId).toBeUndefined();
});
it('does not advance cursors on reads and returns an actionable error without an attachment',async()=>{
 const {harness}=await setup();
 const result=await harness.behavior.callAgentTool('communications_read',{}, {threadId:'A'});
 expect(result).toMatchObject({isError:true});
 const c=await harness.behavior.callRpc('transcripts.import',transcript) as {id:string};
 await harness.behavior.callRpc('attachments.set',{threadId:'A',conversationId:c.id});
 await harness.behavior.callAgentTool('communications_read',{}, {threadId:'A'});
 const a=await harness.behavior.callRpc('attachments.get',{threadId:'A'});
 expect(a).toMatchObject({attachment:{cursor:0}});
 await harness.behavior.callAgentTool('communications_acknowledge',{conversationId:c.id,cursor:1},{threadId:'A'});
 const next=JSON.parse(await harness.behavior.callAgentTool('communications_read',{sinceAcknowledged:true},{threadId:'A'}) as string);
 expect(next.blocks.map((b:{text:string})=>b.text)).toEqual(['Keep the import flow.']);
});
it('keeps import usable without Zoom and rejects invalid imports without creating a conversation',async()=>{
 const {harness}=await setup();
 expect(await harness.behavior.callRpc('sources.status')).toMatchObject({importReady:true,zoom:{enabled:false}});
 await expect(harness.behavior.callRpc('transcripts.import',{title:'Bad',format:'vtt',text:'broken'})).rejects.toThrow();
 expect(await harness.behavior.callRpc('conversations.list',{})).toMatchObject({conversations:[]});
});
it('CLI import/read/attach survives reload; malformed command has nonzero exit',async()=>{
 const {harness}=await setup();
 const imported=await harness.behavior.runCli(['import','Planning','txt','Alex: Add authentication.']);
 expect(imported.exitCode).toBe(0); const c=JSON.parse(imported.stdout);
 expect((await harness.behavior.runCli(['attach',c.id,'A'])).exitCode).toBe(0);
 const replacement=await harness.lifecycle.reload(plugin); hosts.push(replacement);
 const current=await replacement.harness.behavior.runCli(['current','A']); expect(current).toMatchObject({exitCode:0}); expect(JSON.parse(current.stdout).conversation.id).toBe(c.id);
 expect((await replacement.harness.behavior.runCli(['read',c.id,'0','999'])).exitCode).toBe(1);
 expect((await replacement.harness.behavior.runCli(['unknown'])).exitCode).toBe(1);
});
