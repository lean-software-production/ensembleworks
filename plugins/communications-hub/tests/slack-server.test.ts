import { afterEach, expect, it, vi } from 'vitest';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from '../server';

const hosts: ReturnType<typeof createFakePluginHost>[]=[];
afterEach(async()=>{vi.unstubAllGlobals();for(const host of hosts.splice(0))await host.harness.lifecycle.dispose();});

it('exposes bot-member channel search through CLI and agent tools only after read settings are enabled',async()=>{
  const calls:string[]=[];
  vi.stubGlobal('fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));const method=url.pathname.split('/').at(-1)!;calls.push(method);
    const body=method==='auth.test'?{ok:true,team_id:'T1',url:'https://example.slack.com/'}:
      method==='users.conversations'?{ok:true,channels:[{id:'G1',name:'strategy',is_private:true,is_member:true}],response_metadata:{next_cursor:''}}:
      method==='conversations.history'?{ok:true,messages:[{type:'message',ts:'100.000001',text:'The release is Friday',user:'U1'}],response_metadata:{next_cursor:''}}:
      method==='chat.getPermalink'?{ok:true,permalink:'https://example.slack.com/archives/G1/p100000001'}:
      {ok:false,error:'unexpected_method'};
    return new Response(JSON.stringify(body),{status:200});
  });
  const host=createFakePluginHost();hosts.push(host);await plugin(host.bb);
  expect(await host.harness.behavior.callAgentTool('communications_slack_search',{query:'release'},{threadId:'A'}))
    .toMatchObject({isError:true});
  await host.harness.behavior.setSettings({slackReadEnabled:true,slackBotToken:'xoxb-test'});
  expect((await host.harness.behavior.runCli(['slack-sync'])).exitCode).toBe(0);
  const result=JSON.parse(await host.harness.behavior.callAgentTool('communications_slack_search',{query:'release'},{threadId:'A'}) as string);
  expect(result.results[0]).toMatchObject({channelId:'G1',isPrivate:true,text:'The release is Friday',permalink:'https://example.slack.com/archives/G1/p100000001'});
  expect((await host.harness.behavior.runCli(['slack-read','G1'])).stdout).toContain('release');
  expect(calls).not.toContain('chat.postMessage');
  await host.harness.behavior.setSettings({slackReadEnabled:false});
  expect(await host.harness.behavior.callAgentTool('communications_slack_read',{channelId:'G1'},{threadId:'A'}))
    .toMatchObject({isError:true});
});
