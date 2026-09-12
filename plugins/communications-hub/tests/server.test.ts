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
