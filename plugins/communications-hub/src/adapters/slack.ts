import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { SlackStore, type SlackEntryInput } from '../slack-store';

const authResponse = z.object({ok:z.literal(true),team_id:z.string().min(1),url:z.string().url()});
const channel = z.object({id:z.string().min(1),name:z.string().min(1),
  is_member:z.boolean().optional(),is_private:z.boolean().optional(),
  is_im:z.boolean().optional(),is_mpim:z.boolean().optional()});
const message = z.object({type:z.literal('message'),ts:z.string().min(1),
  text:z.string().optional(),user:z.string().optional(),bot_id:z.string().optional(),
  thread_ts:z.string().optional(),reply_count:z.number().optional(),
  edited:z.object({ts:z.string()}).optional(),subtype:z.string().optional()}).passthrough();
const page = z.object({ok:z.literal(true),has_more:z.boolean().optional(),
  response_metadata:z.object({next_cursor:z.string().optional()}).optional()}).passthrough();
class SlackApiError extends Error {
  constructor(method:string, readonly code:string) {super(`Slack ${method}: ${code}`);}
}
const ACCESS_LOST = new Set(['not_in_channel','channel_not_found','no_permission','access_denied','missing_scope']);

export function registerSlack(bb: BbPluginApi, store: SlackStore, changed: () => void,
  request: typeof fetch = fetch) {
  const settings = bb.settings.define({
    slackReadEnabled:{type:'boolean',label:'Enable Slack channel reading',default:false},
    slackBotToken:{type:'string',label:'Slack bot token (read scopes only)',secret:true},
  });
  let teamId: string | null = null;
  let tokenDigest: string | null = null;
  let baseUrl: string | null = null;
  let syncing = false;
  let lastError: string | null = null;
  let lastSyncAt: number | null = null;
  let disposed = false;

  async function api<T>(token: string, method: string, params: Record<string,string>, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const url = new URL(`https://slack.com/api/${method}`);
    for (const [key,value] of Object.entries(params)) url.searchParams.set(key,value);
    for (let attempt=0; attempt<4; attempt++) {
      const response = await request(url,{headers:{Authorization:`Bearer ${token}`},
        signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),redirect:'error'});
      if (response.status===429 && attempt<3) {
        const seconds = Number(response.headers.get('retry-after'));
        await delay(Math.min(60_000,Math.max(1000,Number.isFinite(seconds)?seconds*1000:5000)),undefined,{signal});
        continue;
      }
      if (!response.ok) throw new Error(`Slack ${method} returned HTTP ${response.status}`);
      const raw = await response.text();
      if (raw.length>8_000_000) throw new Error(`Slack ${method} response too large`);
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value!=='object' || !('ok' in value) || value.ok!==true) {
        const code=z.object({error:z.string().regex(/^[a-z_]{1,80}$/)}).safeParse(value);
        throw new SlackApiError(method,code.success?code.data.error:'failed');
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new Error(`Slack ${method} returned an unsupported response`);
      return parsed.data;
    }
    throw new Error(`Slack ${method} rate limited`);
  }

  async function listChannels(token:string, signal?:AbortSignal) {
    const found: Array<{channelId:string;name:string;isPrivate:boolean}> = [];
    let cursor = '';
    do {
      const value = await api(token,'users.conversations',{
        types:'public_channel,private_channel',limit:'200',...(cursor?{cursor}:{})},
      page.extend({channels:z.array(channel)}),signal);
      for (const c of value.channels) if (c.is_member!==false && !c.is_im && !c.is_mpim &&
        (c.id.startsWith('C') || c.id.startsWith('G'))) {
        found.push({channelId:c.id,name:c.name,isPrivate:c.is_private===true});
      }
      const next=value.response_metadata?.next_cursor ?? '';
      if ((value.has_more && !next) || (next && next===cursor)) throw new Error('Slack channel pagination is incomplete');
      cursor = next;
    } while(cursor);
    return found;
  }

  function asEntry(raw: z.infer<typeof message>): SlackEntryInput | null {
    // System events and non-text attachments are outside this text search index.
    if (!raw.text?.trim() || (raw.subtype && !['bot_message','me_message','thread_broadcast','reply_broadcast'].includes(raw.subtype))) return null;
    return {ts:raw.ts,threadTs:raw.thread_ts ?? null,authorId:raw.user ?? raw.bot_id ?? null,
      text:raw.text.slice(0,40_000),editedAt:raw.edited?.ts ?? null};
  }

  async function history(token:string, channelId:string, signal?:AbortSignal) {
    const entries = new Map<string,SlackEntryInput>();
    const parents: string[] = [];
    let cursor = '';
    do {
      const value = await api(token,'conversations.history',{
        channel:channelId,limit:'200',...(cursor?{cursor}:{})},
      page.extend({messages:z.array(message)}),signal);
      for (const m of value.messages) {
        const entry = asEntry(m); if (entry) entries.set(entry.ts,entry);
        if ((m.reply_count ?? 0)>0) parents.push(m.ts);
      }
      const next=value.response_metadata?.next_cursor ?? '';
      if ((value.has_more && !next) || (next && next===cursor)) throw new Error('Slack history pagination is incomplete');
      cursor = next;
    } while(cursor);
    for (const parent of parents) {
      cursor = '';
      do {
        const value = await api(token,'conversations.replies',{
          channel:channelId,ts:parent,limit:'200',...(cursor?{cursor}:{})},
        page.extend({messages:z.array(message)}),signal);
        for (const m of value.messages) {
          const entry=asEntry(m);
          if (entry && (entry.ts!==parent || !entries.has(parent))) entries.set(entry.ts,entry);
        }
        const next=value.response_metadata?.next_cursor ?? '';
        if ((value.has_more && !next) || (next && next===cursor)) throw new Error('Slack reply pagination is incomplete');
        cursor = next;
      } while(cursor);
    }
    return [...entries.values()];
  }

  async function sync(signal?:AbortSignal) {
    if (syncing) throw new Error('Slack sync is already running');
    const config = await settings.get();
    if (!config.slackReadEnabled || !config.slackBotToken) throw new Error('Enable Slack reading and set its bot token in plugin settings');
    syncing = true;
    lastError = null;
    try {
      const auth = await api(config.slackBotToken,'auth.test',{},authResponse,signal);
      teamId = auth.team_id;
      tokenDigest = createHash('sha256').update(config.slackBotToken).digest('hex');
      const origin = new URL(auth.url);
      if (origin.protocol!=='https:' || !origin.hostname.endsWith('.slack.com')) throw new Error('Slack returned an invalid workspace URL');
      baseUrl = origin.origin;
      const channels = await listChannels(config.slackBotToken,signal);
      store.replaceMembership(teamId,channels);
      changed();
      let failed = 0;
      for (const c of channels) {
        if (signal?.aborted || disposed) break;
        try {
          const entries = await history(config.slackBotToken,c.channelId,signal);
          store.reconcile(teamId,c.channelId,'0',entries);
          changed();
        } catch (error) {
          if (signal?.aborted) throw error;
          if (error instanceof SlackApiError && ACCESS_LOST.has(error.code)) {
            store.removeChannel(teamId,c.channelId);
            changed();
          }
          failed++;
          // API and parser errors can contain source data. Status must not.
          lastError = `${failed} channel${failed===1?'':'s'} could not be refreshed`;
        }
      }
      if (!failed && !signal?.aborted && !disposed) lastSyncAt = Date.now();
      syncing = false;
      return status();
    } catch(error) {
      lastError = 'Slack sync failed; check token, scopes, network and rate limits';
      throw error;
    } finally {syncing=false;}
  }

  async function links<T extends {channelId:string;ts:string}>(entries:T[]) {
    const config=await settings.get();
    if (!config.slackReadEnabled || !config.slackBotToken || !baseUrl) return entries.map(entry=>({...entry,permalink:null}));
    return Promise.all(entries.map(async entry => {
      try {
        const result=await api(config.slackBotToken!,'chat.getPermalink',
          {channel:entry.channelId,message_ts:entry.ts},z.object({ok:z.literal(true),permalink:z.string().url()}));
        const url=new URL(result.permalink);
        return {...entry,permalink:url.protocol==='https:' && url.hostname.endsWith('.slack.com')?url.href:null};
      } catch {return {...entry,permalink:null};}
    }));
  }

  const status=()=>({configured:teamId!==null,teamId,channelCount:teamId?store.spaces(teamId).length:0,
    syncing,lastSyncAt,lastError});
  async function authorizedTeam() {
    const config=await settings.get();
    const digest=config.slackBotToken?createHash('sha256').update(config.slackBotToken).digest('hex'):null;
    if (!config.slackReadEnabled || !teamId || digest!==tokenDigest) {
      throw new Error('Slack read access is disabled or its token changed; run bb communications slack-sync');
    }
    return teamId;
  }
  bb.background.service('slack-read-sync',{async start(signal) {
    while(!signal.aborted && !disposed) {
      try {const config=await settings.get();if(config.slackReadEnabled && config.slackBotToken) await sync(signal);}
      catch {/* status records errors; keep retrying */}
      try {await delay(60*60*1000,undefined,{signal});} catch {break;}
    }
  }});
  bb.onDispose(()=>{disposed=true;});
  return {sync,status,links,teamId:()=>teamId,authorizedTeam};
}
