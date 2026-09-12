import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { captureStateSchema, segmentInputSchema, type CaptureState, type Conversation, type Registrant, type Room, type SegmentInput, type ThreadAttachment, type TranscriptSegment } from './domain';

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
  `CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, sourceId TEXT NOT NULL, externalId TEXT NOT NULL,
    joinUrl TEXT NOT NULL, hostUser TEXT NOT NULL, createdAt INTEGER NOT NULL, archivedAt INTEGER,
    UNIQUE(sourceId, externalId))`,
  /**
   * Thread targets supersede `attachments`.
   *
   * A thread must be able to point at a room that has no sitting yet, and the original table
   * declares conversationId NOT NULL. SQLite cannot relax that in place, and the recorded
   * migration cannot be edited, so a new table is created and the existing rows copied. The
   * old table is left untouched: nothing reads it, and dropping it would destroy the only
   * copy of cursor state if a load ever had to fall back.
   */
  `CREATE TABLE IF NOT EXISTS thread_targets (
    threadId TEXT PRIMARY KEY, roomId TEXT REFERENCES rooms(id),
    conversationId TEXT REFERENCES conversations(id), cursor INTEGER NOT NULL DEFAULT 0,
    CHECK (roomId IS NOT NULL OR conversationId IS NOT NULL))`,
  `INSERT OR IGNORE INTO thread_targets(threadId,conversationId,cursor)
    SELECT threadId,conversationId,cursor FROM attachments`,
  `CREATE TABLE IF NOT EXISTS registrants (
    id TEXT PRIMARY KEY, roomId TEXT NOT NULL REFERENCES rooms(id), name TEXT NOT NULL,
    email TEXT NOT NULL, externalId TEXT NOT NULL, joinUrl TEXT NOT NULL, createdAt INTEGER NOT NULL,
    UNIQUE(roomId, email))`,
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
      ['conversations','roomId','TEXT'],
      ['rooms','expiresAt','INTEGER'],
      ['rooms','sourceDeletedAt','INTEGER'],
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
  /**
   * Record a room BB created at the source.
   *
   * The row is written only after the source confirms the meeting, so a room in the database
   * always has a join URL that works. Unique on (sourceId, externalId) so a retried creation
   * cannot leave two rows pointing at one Zoom meeting.
   */
  createRoom(input: {name: string; sourceId: string; externalId: string; joinUrl: string; hostUser: string; expiresAt?: number | null}): Room {
    const parsed=z.object({
      name:z.string().trim().min(1).max(200), sourceId:idSchema, externalId:idSchema,
      joinUrl:z.string().trim().min(1).max(2_048), hostUser:z.string().trim().min(1).max(320),
      expiresAt:z.number().int().positive().nullable().optional(),
    }).strict().parse(input);
    const id=randomUUID();
    this.db.prepare('INSERT INTO rooms(id,name,sourceId,externalId,joinUrl,hostUser,createdAt,expiresAt) VALUES(?,?,?,?,?,?,?,?)')
      .run(id,parsed.name,parsed.sourceId,parsed.externalId,parsed.joinUrl,parsed.hostUser,Date.now(),parsed.expiresAt ?? null);
    this.changed(); return this.getRoom(id);
  }
  /**
   * Record a person registered for a room.
   *
   * Unique on (room, email) so re-registering the same person cannot leave two live links for
   * them, which would make the participant list ambiguous about who is who.
   */
  createRegistrant(input: {roomId: string; name: string; email: string; externalId: string; joinUrl: string}): Registrant {
    const parsed=z.object({
      roomId:idSchema, name:z.string().trim().min(1).max(200),
      email:z.string().trim().min(3).max(320), externalId:idSchema,
      joinUrl:z.string().trim().min(1).max(2_048),
    }).strict().parse(input);
    this.getRoom(parsed.roomId);
    const id=randomUUID();
    this.db.prepare('INSERT INTO registrants(id,roomId,name,email,externalId,joinUrl,createdAt) VALUES(?,?,?,?,?,?,?)')
      .run(id,parsed.roomId,parsed.name,parsed.email,parsed.externalId,parsed.joinUrl,Date.now());
    this.changed(); return this.db.prepare('SELECT * FROM registrants WHERE id=?').get(id) as Registrant;
  }
  /** Record a renewed lifespan. The Zoom meeting is unchanged, so links already issued still work. */
  setRoomExpiry(roomId: string, expiresAt: number): Room {
    this.getRoom(roomId);
    this.db.prepare('UPDATE rooms SET expiresAt=? WHERE id=?').run(z.number().int().positive().parse(expiresAt),roomId);
    this.changed(); return this.getRoom(roomId);
  }
  /**
   * Record that a room's meeting no longer exists at the source.
   *
   * Archived too, because a room whose join URLs are dead should not be offered. The row and
   * its registrants stay: conversations reference the room, and the registrant list is the
   * record of who was given a link that has since been revoked.
   */
  markRoomDeleted(roomId: string): Room {
    this.getRoom(roomId);
    const now=Date.now();
    this.db.prepare('UPDATE rooms SET sourceDeletedAt=coalesce(sourceDeletedAt,?),archivedAt=coalesce(archivedAt,?) WHERE id=?').run(now,now,roomId);
    this.changed(); return this.getRoom(roomId);
  }
  listRegistrants(roomId: string) {
    idSchema.parse(roomId);
    return {registrants:this.db.prepare('SELECT * FROM registrants WHERE roomId=? ORDER BY createdAt,id').all(roomId) as Registrant[]};
  }
  getRoom(id: string): Room {
    idSchema.parse(id);
    const result=this.db.prepare('SELECT * FROM rooms WHERE id=?').get(id) as Room|undefined;
    if (!result) throw new Error('Room not found');
    return result;
  }
  /** Resolve a room from a source identifier, so a capture can be linked to the room it happened in. */
  findRoom(sourceId: string, externalId: string): Room|null {
    idSchema.parse(sourceId); idSchema.parse(externalId);
    return (this.db.prepare('SELECT * FROM rooms WHERE sourceId=? AND externalId=?').get(sourceId,externalId) as Room|undefined) ?? null;
  }
  listRooms(options: {includeArchived?: boolean} = {}) {
    const {includeArchived}=z.object({includeArchived:z.boolean().default(false)}).parse(options);
    const rows=this.db.prepare(`SELECT * FROM rooms ${includeArchived?'':'WHERE archivedAt IS NULL'} ORDER BY createdAt DESC,id`).all() as Room[];
    return {rooms:rows};
  }
  /**
   * Archive a room.
   *
   * Local only: the Zoom meeting is left alone, because deleting it would break a join URL
   * people may still have, and its past conversations stay readable either way.
   */
  archiveRoom(id: string): Room {
    this.getRoom(id);
    this.db.prepare('UPDATE rooms SET archivedAt=coalesce(archivedAt,?) WHERE id=?').run(Date.now(),id);
    this.changed(); return this.getRoom(id);
  }
  /**
   * Rename a conversation only if it still carries the title we expect.
   *
   * A source can learn a better name after a capture has started, but a human may have renamed
   * it in the meantime. Comparing first means the late, automatic name can never overwrite the
   * deliberate one; the compare and write are one statement, so there is no window between them.
   */
  renameIfUnchanged(id: string, expected: string, title: string): Conversation {
    this.getConversation(id);
    const next=z.string().trim().min(1).max(200).parse(title);
    this.db.prepare('UPDATE conversations SET title=? WHERE id=? AND title=?').run(next,id,expected);
    this.changed(); return this.getConversation(id);
  }
  /** Link a capture to the room it happened in. Idempotent: a reconnect re-links the same room. */
  setConversationRoom(conversationId: string, roomId: string): Conversation {
    this.getConversation(conversationId); this.getRoom(roomId);
    this.db.transaction(()=>{
      this.db.prepare('UPDATE conversations SET roomId=? WHERE id=?').run(roomId,conversationId);
      // Threads following this room move to the new sitting. The cursor resets because
      // sequences restart per conversation, so carrying it over would mark the opening of the
      // new sitting as already read.
      this.db.prepare('UPDATE thread_targets SET conversationId=?,cursor=0 WHERE roomId=? AND conversationId IS NOT ?')
        .run(conversationId,roomId,conversationId);
    })();
    this.changed(); return this.getConversation(conversationId);
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
  /** Point a thread at one conversation. The cursor survives re-attaching to the same one. */
  attach(threadId:string,conversationId:string):ThreadAttachment {
    idSchema.parse(threadId); this.getConversation(conversationId);
    this.db.prepare(`INSERT INTO thread_targets(threadId,roomId,conversationId,cursor) VALUES(?,NULL,?,0)
      ON CONFLICT(threadId) DO UPDATE SET roomId=NULL,conversationId=excluded.conversationId,
      cursor=CASE WHEN thread_targets.conversationId=excluded.conversationId THEN thread_targets.cursor ELSE 0 END`).run(threadId,conversationId);
    this.changed(); return this.getAttachment(threadId)!;
  }
  /**
   * Point a thread at a room rather than one sitting in it.
   *
   * A room fragments into a conversation per occupancy period, so a thread attached to one
   * sitting goes stale the moment the room empties and refills - silently, which is the worst
   * way for it to happen. A room target follows, resolving to whichever sitting is current.
   *
   * Attaching to a room with no sitting yet is normal: a team attaches the thread when the
   * room is made, not when someone first speaks.
   */
  attachRoom(threadId:string,roomId:string):ThreadAttachment {
    idSchema.parse(threadId); this.getRoom(roomId);
    const current=this.currentRoomConversation(roomId);
    this.db.prepare(`INSERT INTO thread_targets(threadId,roomId,conversationId,cursor) VALUES(?,?,?,0)
      ON CONFLICT(threadId) DO UPDATE SET roomId=excluded.roomId,conversationId=excluded.conversationId,
      cursor=CASE WHEN thread_targets.conversationId IS excluded.conversationId THEN thread_targets.cursor ELSE 0 END`)
      .run(threadId,roomId,current);
    this.changed(); return this.getAttachment(threadId)!;
  }
  /**
   * The room's most recent sitting, or null before anyone has met in it.
   *
   * Ties on createdAt break by insertion order, not by id. Two sittings can be created in the
   * same millisecond, and ids are random UUIDs, so ordering by id picked an arbitrary one of
   * the two as "latest".
   */
  private currentRoomConversation(roomId:string):string|null {
    const row=this.db.prepare('SELECT id FROM conversations WHERE roomId=? ORDER BY createdAt DESC,rowid DESC LIMIT 1').get(roomId) as {id:string}|undefined;
    return row?.id ?? null;
  }
  detach(threadId:string) { idSchema.parse(threadId); this.db.prepare('DELETE FROM thread_targets WHERE threadId=?').run(threadId); this.changed(); }
  getAttachment(threadId:string):ThreadAttachment|null { idSchema.parse(threadId); return this.db.prepare('SELECT * FROM thread_targets WHERE threadId=?').get(threadId) as ThreadAttachment|undefined ?? null; }
  acknowledge(threadId:string,conversationId:string,cursor:number) {
    z.number().int().nonnegative().parse(cursor); const a=this.getAttachment(threadId);
    if (!a || a.conversationId!==conversationId) throw new Error('Conversation is not attached to this thread');
    const max=(this.db.prepare('SELECT coalesce(max(sequence),0) AS n FROM segments WHERE conversationId=?').get(conversationId) as {n:number}).n;
    if (cursor>max) throw new Error('Cursor exceeds available transcript');
    this.db.prepare('UPDATE thread_targets SET cursor=max(cursor,?) WHERE threadId=?').run(cursor,threadId); this.changed(); return this.getAttachment(threadId)!;
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
