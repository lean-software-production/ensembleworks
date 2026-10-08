import { afterEach, expect, it } from 'vitest';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { Hub } from '../src/hub';
import { SlackStore } from '../src/slack-store';
import { registerSlack } from '../src/adapters/slack';

const hosts: ReturnType<typeof createFakePluginHost>[]=[];
afterEach(async()=>{for(const host of hosts.splice(0))await host.harness.lifecycle.dispose();});

it('indexes bot-member public/private channels and replies, excludes DMs, then reconciles edits and deletes',async()=>{
  const host=createFakePluginHost();hosts.push(host);
  const db=host.bb.storage.database();new Hub(db);
  const store=new SlackStore(db);
  const calls:string[]=[];
  let revision=1;
  const request=(async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));const method=url.pathname.split('/').at(-1)!;
    calls.push(`${method}:${url.searchParams.get('types')??url.searchParams.get('channel')??''}`);
    const response=(()=>{
      if(method==='auth.test')return {ok:true,team_id:'T1',url:'https://example.slack.com/'};
      if(method==='users.conversations')return {ok:true,channels:[
        {id:'C1',name:'team',is_member:true,is_private:false},
        {id:'G1',name:'strategy',is_member:true,is_private:true},
        {id:'D1',name:'direct',is_im:true,is_member:true},
        {id:'C2',name:'not-joined',is_member:false},
      ],response_metadata:{next_cursor:''}};
      if(method==='conversations.history') {
        const channel=url.searchParams.get('channel');
        if(channel==='C1' && revision===4)return {ok:true,messages:[],has_more:true};
        if(channel==='G1' && revision===3)return {ok:false,error:'not_in_channel'};
        return {ok:true,messages:channel==='C1'?[{type:'message',ts:'100.000001',text:'public plan',user:'U1'}]:
          revision===1?[{type:'message',ts:'101.000001',text:'private draft',user:'U2',reply_count:1},
            {type:'message',ts:'102.000001',text:'later deleted',user:'U2'}]:
            [{type:'message',ts:'101.000001',text:'private approved',user:'U2',reply_count:1,edited:{ts:'110.000001'}}],
          response_metadata:{next_cursor:''}};
      }
      if(method==='conversations.replies')return {ok:true,messages:[
        {type:'message',ts:'101.000001',text:revision===1?'private draft':'private approved',user:'U2'},
        {type:'message',ts:'103.000001',thread_ts:'101.000001',text:'reply evidence',user:'U3'},
      ],response_metadata:{next_cursor:''}};
      if(method==='chat.getPermalink')return {ok:true,permalink:'https://example.slack.com/archives/G1/p103000001'};
      throw new Error(`Unexpected Slack method ${method}`);
    })();
    return new Response(JSON.stringify(response),{status:200,headers:{'Content-Type':'application/json'}});
  }) as typeof fetch;
  const slack=registerSlack(host.bb,store,()=>{},request);
  await host.harness.behavior.setSettings({slackReadEnabled:true,slackBotToken:'xoxb-test'});
  expect((await slack.sync()).syncing).toBe(false);
  expect(calls).toContain('users.conversations:public_channel,private_channel');
  expect(calls.some(call=>call.includes(':D1'))).toBe(false);
  expect(store.spaces('T1').map(s=>s.channelId)).toEqual(['G1','C1']);
  expect(store.search('reply',{teamId:await slack.authorizedTeam()})[0]).toMatchObject({channelId:'G1',threadTs:'101.000001'});
  expect((await slack.links(store.search('reply',{teamId:'T1'})))[0]?.permalink).toContain('example.slack.com');
  revision=2;await slack.sync();
  expect(store.search('draft',{teamId:'T1'})).toEqual([]);
  expect(store.search('deleted',{teamId:'T1'})).toEqual([]);
  expect(store.search('approved',{teamId:'T1'})).toMatchObject([{editedAt:'110.000001'}]);
  revision=3;await slack.sync();
  expect(store.search('approved',{teamId:'T1'})).toEqual([]);
  expect(slack.status().lastError).toMatch(/1 channel/);
  revision=4;await slack.sync();
  expect(store.search('public',{teamId:'T1'})).toHaveLength(1);
  expect(slack.status().lastError).toMatch(/1 channel/);
  await host.harness.behavior.setSettings({slackReadEnabled:false});
  await expect(slack.authorizedTeam()).rejects.toThrow(/disabled/);
});
