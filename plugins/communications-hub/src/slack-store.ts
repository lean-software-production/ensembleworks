import type Database from 'better-sqlite3';
import { z } from 'zod';

const key = z.string().min(1).max(256);
export const slackEntryInput = z.object({
  ts: key, threadTs: key.nullable(), authorId: key.nullable(),
  text: z.string().max(40_000), editedAt: key.nullable(),
});
export type SlackEntryInput = z.infer<typeof slackEntryInput>;
export interface SlackEntry extends SlackEntryInput {
  teamId: string; channelId: string; channelName: string; isPrivate: boolean;
}
export interface SlackSpace {
  teamId: string; channelId: string; name: string; isPrivate: boolean;
  lastSyncAt: number | null;
}
type StoredSpace = Omit<SlackSpace,'isPrivate'> & {isPrivate:number};
type StoredEntry = Omit<SlackEntry,'isPrivate'> & {isPrivate:number};

/** Mutable channel messages live beside immutable meeting transcripts. */
export class SlackStore {
  constructor(private db: Database.Database) {}

  replaceMembership(teamId: string, spaces: Omit<SlackSpace, 'teamId' | 'lastSyncAt'>[]) {
    key.parse(teamId);
    const parsed = z.array(z.object({channelId:key,name:z.string().min(1).max(200),isPrivate:z.boolean()})).parse(spaces);
    this.db.transaction(() => {
      // One bot connection belongs to one workspace. Retire cached content
      // from a prior token before it can be mistaken for current access.
      this.db.prepare('DELETE FROM slack_entries WHERE teamId<>?').run(teamId);
      this.db.prepare('DELETE FROM slack_spaces WHERE teamId<>?').run(teamId);
      this.db.prepare('UPDATE slack_spaces SET active=0 WHERE teamId=?').run(teamId);
      const upsert = this.db.prepare(`INSERT INTO slack_spaces(teamId,channelId,name,isPrivate,active)
        VALUES(?,?,?,?,1) ON CONFLICT(teamId,channelId) DO UPDATE SET
        name=excluded.name,isPrivate=excluded.isPrivate,active=1,
        lastSyncAt=CASE WHEN slack_spaces.active=1 THEN slack_spaces.lastSyncAt ELSE NULL END`);
      for (const s of parsed) upsert.run(teamId,s.channelId,s.name,Number(s.isPrivate));
      // A channel the bot left must not remain readable through the local cache.
      this.db.prepare(`DELETE FROM slack_entries WHERE teamId=? AND channelId IN
        (SELECT channelId FROM slack_spaces WHERE teamId=? AND active=0)`).run(teamId,teamId);
    })();
  }

  removeChannel(teamId:string, channelId:string) {
    key.parse(teamId);key.parse(channelId);
    this.db.transaction(()=>{
      this.db.prepare('DELETE FROM slack_entries WHERE teamId=? AND channelId=?').run(teamId,channelId);
      this.db.prepare('UPDATE slack_spaces SET active=0,lastSyncAt=NULL WHERE teamId=? AND channelId=?').run(teamId,channelId);
    })();
  }

  spaces(teamId: string): SlackSpace[] {
    return (this.db.prepare(`SELECT teamId,channelId,name,isPrivate,lastSyncAt FROM slack_spaces
      WHERE teamId=? AND active=1 ORDER BY name`).all(key.parse(teamId)) as StoredSpace[])
      .map(s => ({...s,isPrivate:Boolean(s.isPrivate)}));
  }

  /** A complete snapshot of a time window also removes edits/deletions missed while offline. */
  reconcile(teamId: string, channelId: string, oldest: string, entries: SlackEntryInput[]) {
    key.parse(teamId); key.parse(channelId); key.parse(oldest);
    const parsed = z.array(slackEntryInput).parse(entries);
    this.db.transaction(() => {
      const active = this.db.prepare('SELECT 1 FROM slack_spaces WHERE teamId=? AND channelId=? AND active=1').get(teamId,channelId);
      if (!active) throw new Error('Slack channel is not in the bot membership snapshot');
      const seen = new Set(parsed.map(e => e.ts));
      const old = this.db.prepare('SELECT ts FROM slack_entries WHERE teamId=? AND channelId=? AND ts>=?').all(teamId,channelId,oldest) as {ts:string}[];
      const remove = this.db.prepare('DELETE FROM slack_entries WHERE teamId=? AND channelId=? AND ts=?');
      for (const row of old) if (!seen.has(row.ts)) remove.run(teamId,channelId,row.ts);
      const upsert = this.db.prepare(`INSERT INTO slack_entries(teamId,channelId,ts,threadTs,authorId,text,editedAt,receivedAt)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(teamId,channelId,ts) DO UPDATE SET
        threadTs=excluded.threadTs,authorId=excluded.authorId,text=excluded.text,editedAt=excluded.editedAt
        WHERE slack_entries.threadTs IS NOT excluded.threadTs
          OR slack_entries.authorId IS NOT excluded.authorId
          OR slack_entries.text IS NOT excluded.text
          OR slack_entries.editedAt IS NOT excluded.editedAt`);
      const now = Date.now();
      for (const e of parsed) upsert.run(teamId,channelId,e.ts,e.threadTs,e.authorId,e.text,e.editedAt,now);
      this.db.prepare('UPDATE slack_spaces SET lastSyncAt=? WHERE teamId=? AND channelId=?').run(now,teamId,channelId);
    })();
  }

  search(query: string, options: {teamId:string; channelId?:string; before?:string; limit?:number}) {
    const input = z.object({teamId:key,channelId:key.optional(),before:key.optional(),limit:z.number().int().min(1).max(30).default(10)}).parse(options);
    const terms = z.string().trim().min(1).max(200).parse(query).match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!terms.length) return [];
    const where = ['s.active=1','slack_entry_search MATCH ?','e.teamId=?'];
    const params: Array<string|number> = [terms.map(t => `"${t}"`).join(' AND '),input.teamId];
    if (input.channelId) { where.push('e.channelId=?'); params.push(input.channelId); }
    if (input.before) {where.push('e.ts<?');params.push(input.before);}
    const rows = this.db.prepare(`SELECT e.teamId,e.channelId,s.name AS channelName,s.isPrivate,
      e.ts,e.threadTs,e.authorId,e.text,e.editedAt FROM slack_entry_search
      JOIN slack_entries e ON e.rowid=slack_entry_search.rowid
      JOIN slack_spaces s ON s.teamId=e.teamId AND s.channelId=e.channelId
      WHERE ${where.join(' AND ')} ORDER BY e.ts DESC LIMIT ?`).all(...params,input.limit) as StoredEntry[];
    return rows.map(e => ({...e,isPrivate:Boolean(e.isPrivate)}));
  }

  read(teamId: string, channelId: string, options: {before?:string; limit?:number} = {}) {
    const input = z.object({before:key.optional(),limit:z.number().int().min(1).max(30).default(20)}).parse(options);
    const rows = this.db.prepare(`SELECT e.teamId,e.channelId,s.name AS channelName,s.isPrivate,
      e.ts,e.threadTs,e.authorId,e.text,e.editedAt FROM slack_entries e
      JOIN slack_spaces s ON s.teamId=e.teamId AND s.channelId=e.channelId
      WHERE s.active=1 AND e.teamId=? AND e.channelId=? AND (? IS NULL OR e.ts<?)
      ORDER BY e.ts DESC LIMIT ?`).all(key.parse(teamId),key.parse(channelId),input.before ?? null,input.before ?? null,input.limit) as StoredEntry[];
    return rows.map(e => ({...e,isPrivate:Boolean(e.isPrivate)}));
  }
}
