import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { captureStateSchema, segmentInputSchema, type CaptureState, type Conversation, type SegmentInput, type ThreadAttachment, type TranscriptSegment } from './domain';

export const readOptionsSchema = z.object({
  after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(30).default(20),
  fromMs: z.number().int().nonnegative().optional(), toMs: z.number().int().nonnegative().optional(),
}).strict().refine(o => o.fromMs === undefined || o.toMs === undefined || o.toMs >= o.fromMs, 'Invalid time range');
export type ReadOptions = z.input<typeof readOptionsSchema>;
export interface TranscriptPage { conversation: Conversation; segments: TranscriptSegment[]; hasMore: boolean; nextCursor: number; }
const idSchema = z.string().trim().min(1).max(256);
export const migrations = [
  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY, sourceId TEXT NOT NULL, externalId TEXT NOT NULL, title TEXT NOT NULL,
    createdAt INTEGER NOT NULL, captureStartedAt INTEGER, lastReceivedAt INTEGER,
    captureState TEXT NOT NULL DEFAULT 'idle', captureDetail TEXT, interruptionCount INTEGER NOT NULL DEFAULT 0,
    UNIQUE(sourceId, externalId))`,
  `CREATE TABLE IF NOT EXISTS segments (
    id TEXT NOT NULL UNIQUE, conversationId TEXT NOT NULL REFERENCES conversations(id),
    sequence INTEGER NOT NULL, sourceKey TEXT NOT NULL, speaker TEXT, text TEXT NOT NULL,
    startMs INTEGER, endMs INTEGER, receivedAt INTEGER NOT NULL,
    UNIQUE(conversationId, sourceKey), UNIQUE(conversationId, sequence))`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS segment_search USING fts5(text, content='segments', content_rowid='rowid')`,
  `CREATE TRIGGER IF NOT EXISTS segments_insert AFTER INSERT ON segments BEGIN
    INSERT INTO segment_search(rowid,text) VALUES (new.rowid,new.text); END`,
  `CREATE TABLE IF NOT EXISTS attachments (
    threadId TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id), cursor INTEGER NOT NULL DEFAULT 0)`,
];

/** SQLite owns runtime state. No platform or BB-thread API dependencies. */
export class Hub {
  constructor(private db: Database.Database, private changed: () => void = () => {}, migrate?: (statements: string[]) => void) {
    if (migrate) migrate(migrations); else db.transaction(() => migrations.forEach(s=>db.exec(s)))();
    this.ensureColumns();
  }
  /**
   * Add columns introduced after a table was first created.
   *
   * The statements in `migrations` are immutable: BB records them by index and
   * refuses to load a plugin that edits one, so a new column cannot be added to
   * an existing CREATE TABLE. Appending an ALTER does not work either, because
   * SQLite has no `ADD COLUMN IF NOT EXISTS` and the non-BB path replays every
   * statement on each construction.
   *
   * Checking the current shape is idempotent under both, and covers a fresh
   * database and an upgraded one by the same route.
   */
  private ensureColumns() {
    const additions: [string, string, string][] = [
      ['conversations','captureEndedAt','INTEGER'],
      ['segments','speakerId','TEXT'],
    ];
    for (const [table,column,type] of additions) {
      const columns=this.db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[];
      if (!columns.some(c=>c.name===column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
  ensureConversation(sourceId: string, externalId: string, title: string): Conversation {
    idSchema.parse(sourceId); idSchema.parse(externalId); title=z.string().trim().min(1).max(200).parse(title);
    const existing=this.db.prepare('SELECT id FROM conversations WHERE sourceId=? AND externalId=?').get(sourceId,externalId) as {id:string}|undefined;
    if (existing) return this.getConversation(existing.id);
    const id=randomUUID(); this.db.prepare('INSERT INTO conversations(id,sourceId,externalId,title,createdAt) VALUES(?,?,?,?,?)').run(id,sourceId,externalId,title,Date.now());
    this.changed(); return this.getConversation(id);
  }
  /**
   * Rename a conversation.
   *
   * Source-derived titles name the room, not the discussion: Zoom's RTMS events carry no
   * topic, so a capture is only ever "Zoom meeting <id>". A human-chosen title is what
   * makes a conversation findable later. Passages are untouched, so citations still hold.
   */
  renameConversation(id: string, title: string): Conversation {
    this.getConversation(id);
    const next=z.string().trim().min(1).max(200).parse(title);
    this.db.prepare('UPDATE conversations SET title=? WHERE id=?').run(next,id);
    this.changed(); return this.getConversation(id);
  }
  getConversation(id: string): Conversation {
    idSchema.parse(id);
    const result=this.db.prepare('SELECT c.*, (SELECT count(*) FROM segments s WHERE s.conversationId=c.id) AS segmentCount FROM conversations c WHERE id=?').get(id) as Conversation|undefined;
    if (!result) throw new Error('Conversation not found');
    return result;
  }
  listConversations(options: {offset?: number; limit?: number} = {}) {
    const {offset,limit}=z.object({offset:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(100).default(50)}).parse(options);
    const rows=this.db.prepare('SELECT c.*, (SELECT count(*) FROM segments s WHERE s.conversationId=c.id) AS segmentCount FROM conversations c ORDER BY c.createdAt DESC,c.id LIMIT ? OFFSET ?').all(limit+1,offset) as Conversation[];
    return {conversations:rows.slice(0,limit),hasMore:rows.length>limit,nextOffset:offset+Math.min(rows.length,limit)};
  }
  appendSegments(conversationId: string, inputs: SegmentInput[]) {
    this.getConversation(conversationId);
    const segments=z.array(segmentInputSchema).max(10000).parse(inputs);
    const added=this.db.transaction(()=>{
      let sequence=(this.db.prepare('SELECT coalesce(max(sequence),0) AS n FROM segments WHERE conversationId=?').get(conversationId) as {n:number}).n;
      let count=0; const now=Date.now();
      const insert=this.db.prepare('INSERT OR IGNORE INTO segments(id,conversationId,sequence,sourceKey,speaker,speakerId,text,startMs,endMs,receivedAt) VALUES(?,?,?,?,?,?,?,?,?,?)');
      for (const s of segments) {
        const result=insert.run(randomUUID(),conversationId,sequence+1,s.sourceKey,s.speaker,s.speakerId ?? null,s.text,s.startMs,s.endMs,now);
        if (result.changes) { sequence++; count++; }
      }
      if (count) this.db.prepare('UPDATE conversations SET lastReceivedAt=? WHERE id=?').run(now,conversationId);
      return count;
    })();
    if (added) this.changed(); return added;
  }
  importConversation(title: string, segments: SegmentInput[]) {
    // Validate the entire batch before creating anything, and roll back the conversation if insertion fails.
    z.array(segmentInputSchema).min(1).max(10000).parse(segments);
    return this.db.transaction(()=>{
      const c=this.ensureConversation('import',randomUUID(),title); this.appendSegments(c.id,segments); return this.getConversation(c.id);
    })();
  }
  setCapture(id: string, state: CaptureState, detail: string|null = null) {
    this.getConversation(id); captureStateSchema.parse(state); z.string().max(500).nullable().parse(detail);
    // captureEndedAt keeps the FIRST moment capture stopped being active and clears on
    // resumption, so a stream that dies and is never recovered is not credited with the
    // dead time. lastReceivedAt cannot substitute: it misses trailing silence, which
    // measured 35-37% of two real meetings.
    this.db.prepare(`UPDATE conversations SET interruptionCount=interruptionCount+CASE WHEN ? IN ('interrupted','paused','stopped') AND captureState IN ('connecting','capturing') THEN 1 ELSE 0 END, captureState=?,captureDetail=?,captureStartedAt=CASE
      WHEN ? IN ('connecting','capturing') THEN coalesce(captureStartedAt,?) ELSE captureStartedAt END,
      captureEndedAt=CASE WHEN ? IN ('connecting','capturing') THEN NULL ELSE coalesce(captureEndedAt,?) END WHERE id=?`).run(state,state,detail,state,Date.now(),state,Date.now(),id);
    this.changed(); return this.getConversation(id);
  }
  interruptActiveCaptures() {
    this.db.prepare("UPDATE conversations SET interruptionCount=interruptionCount+1,captureState='interrupted',captureDetail='Capture interrupted by plugin restart; earlier passages remain available.' WHERE captureState IN ('connecting','capturing','paused')").run();
  }
  attach(threadId:string,conversationId:string):ThreadAttachment {
    idSchema.parse(threadId); this.getConversation(conversationId);
    this.db.prepare(`INSERT INTO attachments(threadId,conversationId,cursor) VALUES(?,?,0)
      ON CONFLICT(threadId) DO UPDATE SET conversationId=excluded.conversationId,
      cursor=CASE WHEN attachments.conversationId=excluded.conversationId THEN attachments.cursor ELSE 0 END`).run(threadId,conversationId);
    this.changed(); return this.getAttachment(threadId)!;
  }
  detach(threadId:string) { idSchema.parse(threadId); this.db.prepare('DELETE FROM attachments WHERE threadId=?').run(threadId); this.changed(); }
  getAttachment(threadId:string):ThreadAttachment|null { idSchema.parse(threadId); return this.db.prepare('SELECT * FROM attachments WHERE threadId=?').get(threadId) as ThreadAttachment|undefined ?? null; }
  acknowledge(threadId:string,conversationId:string,cursor:number) {
    z.number().int().nonnegative().parse(cursor); const a=this.getAttachment(threadId);
    if (!a || a.conversationId!==conversationId) throw new Error('Conversation is not attached to this thread');
    const max=(this.db.prepare('SELECT coalesce(max(sequence),0) AS n FROM segments WHERE conversationId=?').get(conversationId) as {n:number}).n;
    if (cursor>max) throw new Error('Cursor exceeds available transcript');
    this.db.prepare('UPDATE attachments SET cursor=max(cursor,?) WHERE threadId=?').run(cursor,threadId); this.changed(); return this.getAttachment(threadId)!;
  }
  readTranscript(conversationId:string,options:ReadOptions = {}):TranscriptPage { return this.queryTranscript(conversationId,options); }
  searchTranscript(conversationId:string,options:ReadOptions & {query:string}):TranscriptPage {
    const {query,...read}=options; const q=z.string().trim().min(1).max(200).parse(query);
    // Literal FTS terms prevent arbitrary FTS operators/syntax from untrusted search text.
    const terms=q.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!terms.length) return {conversation:this.getConversation(conversationId),segments:[],hasMore:false,nextCursor:readOptionsSchema.parse(read).after};
    return this.queryTranscript(conversationId,read,terms.map(t=>'"'+t+'"').join(' AND '));
  }
  private queryTranscript(conversationId:string,options:ReadOptions,match?:string):TranscriptPage {
    const conversation=this.getConversation(conversationId); const o=readOptionsSchema.parse(options);
    const conditions=['s.conversationId=?','s.sequence>?']; const params: (string|number)[]=[conversationId,o.after];
    if (o.fromMs!==undefined) {conditions.push('s.startMs IS NOT NULL AND coalesce(s.endMs,s.startMs)>?'); params.push(o.fromMs);}
    if (o.toMs!==undefined) {conditions.push('s.startMs IS NOT NULL AND s.startMs<?'); params.push(o.toMs);}
    if (match) {conditions.push('segment_search MATCH ?'); params.push(match);}
    const join=match?' JOIN segment_search ON segment_search.rowid=s.rowid':'';
    const rows=this.db.prepare(`SELECT s.* FROM segments s${join} WHERE ${conditions.join(' AND ')} ORDER BY s.sequence LIMIT ?`).all(...params,o.limit+1) as TranscriptSegment[];
    const segments=rows.slice(0,o.limit);
    return {conversation,segments,hasMore:rows.length>o.limit,nextCursor:segments.at(-1)?.sequence ?? o.after};
  }
}
