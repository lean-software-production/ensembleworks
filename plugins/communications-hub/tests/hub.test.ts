import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub } from '../src/hub';

const databases: Database.Database[] = [];
function setup() { const db = new Database(':memory:'); databases.push(db); return {db, hub: new Hub(db)}; }
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const segment = (key: string, text = 'We agreed to add authentication.', startMs: number | null = 1000) => ({sourceKey:key,speaker:'Alex',text,startMs,endMs:startMs === null ? null : startMs+1000});

describe('persistent conversation library', () => {
  it('keeps immutable passages and attachment state when the hub is reconstructed', () => {
    const {db,hub} = setup(); const m=hub.ensureConversation('import','one','Planning');
    hub.appendSegments(m.id,[segment('a')]); hub.attach('thread-a',m.id);
    const before=hub.readTranscript(m.id,{}); const reopened=new Hub(db);
    expect(reopened.getAttachment('thread-a')).toEqual({threadId:'thread-a',conversationId:m.id,cursor:0});
    expect(reopened.readTranscript(m.id,{}).segments).toEqual(before.segments);
    expect(reopened.ensureConversation('import','one','New title').id).toBe(m.id);
  });
  it('deduplicates retransmission without replacing cited text and rejects invalid batches atomically', () => {
    const {hub}=setup(); const m=hub.ensureConversation('zoom','occurrence','Planning');
    hub.appendSegments(m.id,[segment('a')]); hub.appendSegments(m.id,[segment('a','Different text')]);
    expect(() => hub.appendSegments(m.id,[segment('b'),segment('c','x'.repeat(2001))])).toThrow();
    expect(hub.readTranscript(m.id,{}).segments.map(s=>s.text)).toEqual(['We agreed to add authentication.']);
  });
  it('isolates reading cursors and includes late speech by ingestion sequence', () => {
    const {hub}=setup(); const m=hub.ensureConversation('import','one','Planning');
    hub.appendSegments(m.id,[segment('a'),segment('b')]); hub.attach('A',m.id); hub.attach('B',m.id);
    hub.acknowledge('A',m.id,2); hub.appendSegments(m.id,[segment('late','A late correction',0)]);
    expect(hub.readTranscript(m.id,{after:hub.getAttachment('A')!.cursor}).segments.map(s=>s.text)).toEqual(['A late correction']);
    expect(hub.getAttachment('B')!.cursor).toBe(0);
    expect(() => hub.acknowledge('B',m.id,100)).toThrow();
    const other=hub.ensureConversation('import','two','Other'); expect(() => hub.acknowledge('A',other.id,1)).toThrow();
    hub.attach('A',other.id); expect(hub.getAttachment('A')!.cursor).toBe(0);
    hub.detach('A'); expect(hub.getConversation(m.id).segmentCount).toBe(3);
  });
  it('returns bounded pages with a next cursor and filters speech intervals', () => {
    const {hub}=setup(); const m=hub.ensureConversation('import','one','Planning');
    hub.appendSegments(m.id,Array.from({length:33},(_,i)=>segment(String(i),'passage '+i,i*1000)));
    const first=hub.readTranscript(m.id,{limit:30}); expect(first.segments).toHaveLength(30); expect(first.hasMore).toBe(true);
    expect(hub.readTranscript(m.id,{after:first.nextCursor}).segments).toHaveLength(3);
    expect(hub.readTranscript(m.id,{fromMs:1500,toMs:2500}).segments.map(s=>s.text)).toEqual(['passage 1','passage 2']);
    expect(() => hub.readTranscript(m.id,{limit:500})).toThrow();
  });
  it('searches only the chosen conversation and treats user punctuation as data', () => {
    const {hub}=setup(); const a=hub.ensureConversation('import','a','A'), b=hub.ensureConversation('import','b','B');
    hub.appendSegments(a.id,[segment('a','Authentication rollout is agreed'),segment('b','Other')]);
    hub.appendSegments(b.id,[segment('a','Authentication rollout is cancelled')]);
    expect(hub.searchTranscript(a.id,{query:'authentication rollout'}).segments.map(s=>s.text)).toEqual(['Authentication rollout is agreed']);
    expect(() => hub.searchTranscript(a.id,{query:'" OR * --'})).not.toThrow();
    expect(() => hub.readTranscript('missing',{})).toThrow(/conversation/i);
  });
  it('marks previously active captures interrupted on restart without marking stored imports live', () => {
    const {hub}=setup(); const m=hub.ensureConversation('zoom','one','Live'); hub.setCapture(m.id,'capturing');
    const imported=hub.ensureConversation('import','two','Stored'); hub.interruptActiveCaptures();
    expect(hub.getConversation(m.id).captureState).toBe('interrupted');
    hub.setCapture(m.id,'capturing'); expect(hub.getConversation(m.id).interruptionCount).toBe(1); expect(hub.getConversation(imported.id).captureState).toBe('idle');
  });
});
describe('capture window accounting', () => {
  it('bounds the stream window with captureEndedAt instead of the last passage', () => {
    // lastReceivedAt misses trailing silence: on two real meetings it undercounted the
    // billed stream by 35-37%, which makes it useless for cost accounting.
    const {hub}=setup(); const m=hub.ensureConversation('zoom','occurrence','Live');
    hub.setCapture(m.id,'capturing');
    expect(hub.getConversation(m.id).captureEndedAt).toBeNull();
    hub.setCapture(m.id,'ended','Zoom meeting ended');
    const ended=hub.getConversation(m.id);
    expect(ended.captureEndedAt).not.toBeNull();
    expect(ended.captureEndedAt!).toBeGreaterThanOrEqual(ended.captureStartedAt!);
  });
  it('keeps the first moment capture stopped, so dead time is not billed as streaming', () => {
    const {hub}=setup(); const m=hub.ensureConversation('zoom','occurrence','Live');
    hub.setCapture(m.id,'capturing');
    hub.setCapture(m.id,'interrupted','Signaling closed');
    const first=hub.getConversation(m.id).captureEndedAt;
    hub.setCapture(m.id,'ended','Zoom meeting ended');
    expect(hub.getConversation(m.id).captureEndedAt).toBe(first);
  });
  it('clears the end time when a capture resumes', () => {
    const {hub}=setup(); const m=hub.ensureConversation('zoom','occurrence','Live');
    hub.setCapture(m.id,'capturing'); hub.setCapture(m.id,'interrupted','Signaling closed');
    expect(hub.getConversation(m.id).captureEndedAt).not.toBeNull();
    hub.setCapture(m.id,'capturing');
    expect(hub.getConversation(m.id).captureEndedAt).toBeNull();
  });
  it('stores the source participant id alongside the self-chosen display name', () => {
    const {hub}=setup(); const m=hub.ensureConversation('zoom','occurrence','Live');
    hub.appendSegments(m.id,[{...segment('a'),speakerId:'16778240'}]);
    expect(hub.readTranscript(m.id,{}).segments[0]!.speakerId).toBe('16778240');
  });
  it('leaves speakerId null for sources that do not supply one', () => {
    const {hub}=setup(); const m=hub.ensureConversation('import','one','Planning');
    hub.appendSegments(m.id,[segment('a')]);
    expect(hub.readTranscript(m.id,{}).segments[0]!.speakerId).toBeNull();
  });
});

describe('schema upgrades', () => {
  it('adds new columns to a database created before they existed, keeping stored passages', () => {
    // SQLite has no ADD COLUMN IF NOT EXISTS and CREATE TABLE IF NOT EXISTS is a no-op on
    // an existing database, so this is the path a real installation takes on upgrade.
    const db = new Database(':memory:'); databases.push(db);
    db.exec(`CREATE TABLE conversations (
      id TEXT PRIMARY KEY, sourceId TEXT NOT NULL, externalId TEXT NOT NULL, title TEXT NOT NULL,
      createdAt INTEGER NOT NULL, captureStartedAt INTEGER, lastReceivedAt INTEGER,
      captureState TEXT NOT NULL DEFAULT 'idle', captureDetail TEXT, interruptionCount INTEGER NOT NULL DEFAULT 0,
      UNIQUE(sourceId, externalId))`);
    db.exec(`CREATE TABLE segments (
      id TEXT NOT NULL UNIQUE, conversationId TEXT NOT NULL REFERENCES conversations(id),
      sequence INTEGER NOT NULL, sourceKey TEXT NOT NULL, speaker TEXT, text TEXT NOT NULL,
      startMs INTEGER, endMs INTEGER, receivedAt INTEGER NOT NULL,
      UNIQUE(conversationId, sourceKey), UNIQUE(conversationId, sequence))`);
    db.prepare('INSERT INTO conversations(id,sourceId,externalId,title,createdAt) VALUES(?,?,?,?,?)')
      .run('old','zoom','occurrence','Earlier meeting',1);
    db.prepare('INSERT INTO segments(id,conversationId,sequence,sourceKey,speaker,text,startMs,endMs,receivedAt) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('seg','old',1,'key','Alex','We agreed to add authentication.',1000,2000,5);

    const hub = new Hub(db);

    const conversation = hub.getConversation('old');
    expect(conversation.captureEndedAt).toBeNull();
    expect(conversation.title).toBe('Earlier meeting');
    const [segment] = hub.readTranscript('old',{}).segments;
    expect(segment!.text).toBe('We agreed to add authentication.');
    expect(segment!.speakerId).toBeNull();
    // Constructing again must not fail on the columns the first construction added.
    expect(() => new Hub(db)).not.toThrow();
  });
});

describe('renaming', () => {
  it('renames a conversation without disturbing its passages or citations', () => {
    const {hub}=setup(); const m=hub.ensureConversation('zoom','occurrence','Zoom meeting 881 · 2026-09-11 22:01Z');
    hub.appendSegments(m.id,[segment('a'),segment('b')]);
    const before=hub.readTranscript(m.id,{}).segments;

    const renamed=hub.renameConversation(m.id,'  Attribution design  ');

    expect(renamed.title).toBe('Attribution design');
    expect(hub.getConversation(m.id).title).toBe('Attribution design');
    expect(hub.readTranscript(m.id,{}).segments).toEqual(before);
  });
  it('rejects an empty title rather than leaving a conversation unnamed', () => {
    const {hub}=setup(); const m=hub.ensureConversation('import','one','Planning');
    expect(()=>hub.renameConversation(m.id,'   ')).toThrow();
    expect(hub.getConversation(m.id).title).toBe('Planning');
  });
  it('keeps the chosen title when the source re-announces the same conversation', () => {
    // ensureConversation runs on every reconnect; a source-derived title must not
    // overwrite the one a human chose.
    const {hub}=setup(); const m=hub.ensureConversation('zoom','occurrence','Zoom meeting 881');
    hub.renameConversation(m.id,'Attribution design');
    expect(hub.ensureConversation('zoom','occurrence','Zoom meeting 881').title).toBe('Attribution design');
  });
});
