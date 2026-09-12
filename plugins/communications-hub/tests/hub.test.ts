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
    expect(reopened.getAttachment('thread-a')).toEqual({threadId:'thread-a',roomId:null,conversationId:m.id,cursor:0});
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
  it('carries existing attachments into the table that supersedes them', () => {
    // conversationId was NOT NULL, which a room target with no sitting cannot satisfy, and the
    // recorded migration cannot be edited. A thread attached before the upgrade must keep its
    // conversation and its cursor across the move.
    const db = new Database(':memory:'); databases.push(db);
    db.exec(`CREATE TABLE conversations (
      id TEXT PRIMARY KEY, sourceId TEXT NOT NULL, externalId TEXT NOT NULL, title TEXT NOT NULL,
      createdAt INTEGER NOT NULL, captureStartedAt INTEGER, lastReceivedAt INTEGER,
      captureState TEXT NOT NULL DEFAULT 'idle', captureDetail TEXT, interruptionCount INTEGER NOT NULL DEFAULT 0,
      UNIQUE(sourceId, externalId))`);
    db.exec(`CREATE TABLE attachments (
      threadId TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id), cursor INTEGER NOT NULL DEFAULT 0)`);
    db.prepare('INSERT INTO conversations(id,sourceId,externalId,title,createdAt) VALUES(?,?,?,?,?)')
      .run('old','zoom','occurrence','Earlier meeting',1);
    db.prepare('INSERT INTO attachments(threadId,conversationId,cursor) VALUES(?,?,?)').run('thread-a','old',4);

    const hub=new Hub(db);

    expect(hub.getAttachment('thread-a')).toEqual({threadId:'thread-a',roomId:null,conversationId:'old',cursor:4});
  });
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

describe('rooms', () => {
  const roomInput = (externalId = '88800011122') => ({
    name:'Team standup', sourceId:'zoom', externalId,
    joinUrl:'https://zoom.us/j/88800011122?pwd=tok', hostUser:'operator@example.com',
  });
  it('stores a room and finds it by the identifier the source reports', () => {
    const {hub}=setup(); const room=hub.createRoom(roomInput());
    expect(room.archivedAt).toBeNull();
    // The Zoom meeting id is what an rtms_started event carries, so it is the lookup key.
    expect(hub.findRoom('zoom','88800011122')?.id).toBe(room.id);
    expect(hub.findRoom('zoom','other')).toBeNull();
  });
  it('refuses a second room for the same source meeting', () => {
    // A retried creation must not leave two rows pointing at one Zoom meeting, or a capture
    // would link to whichever the lookup happened to return.
    const {hub}=setup(); hub.createRoom(roomInput());
    expect(()=>hub.createRoom(roomInput())).toThrow();
  });
  it('gathers the sittings of one room together', () => {
    const {hub}=setup(); const room=hub.createRoom(roomInput());
    const first=hub.ensureConversation('zoom','occurrence-1','Zoom meeting 888 · first');
    const second=hub.ensureConversation('zoom','occurrence-2','Zoom meeting 888 · second');
    hub.setConversationRoom(first.id,room.id); hub.setConversationRoom(second.id,room.id);

    expect(hub.getConversation(first.id).roomId).toBe(room.id);
    expect(hub.getConversation(second.id).roomId).toBe(room.id);
  });
  it('leaves a conversation roomless when it happened outside a room', () => {
    const {hub}=setup();
    expect(hub.ensureConversation('import','one','Planning').roomId).toBeNull();
  });
  it('re-linking the same room is harmless', () => {
    // A reconnect calls this again for a capture that is already linked.
    const {hub}=setup(); const room=hub.createRoom(roomInput());
    const m=hub.ensureConversation('zoom','occurrence','Zoom meeting 888');
    hub.setConversationRoom(m.id,room.id);
    expect(hub.setConversationRoom(m.id,room.id).roomId).toBe(room.id);
  });
  it('rejects linking to a room that does not exist', () => {
    const {hub}=setup(); const m=hub.ensureConversation('zoom','occurrence','Zoom meeting 888');
    expect(()=>hub.setConversationRoom(m.id,'missing')).toThrow('Room not found');
  });
  it('hides archived rooms from the default listing but keeps them readable', () => {
    const {hub}=setup(); const room=hub.createRoom(roomInput());
    const archived=hub.archiveRoom(room.id);

    expect(archived.archivedAt).toBeGreaterThan(0);
    expect(hub.listRooms().rooms).toEqual([]);
    expect(hub.listRooms({includeArchived:true}).rooms.map(r=>r.id)).toEqual([room.id]);
    // The join URL survives archiving: people may still hold it, and past sittings stay readable.
    expect(hub.getRoom(room.id).joinUrl).toBe(roomInput().joinUrl);
  });
  it('keeps the first archive time when archived twice', () => {
    const {hub}=setup(); const room=hub.createRoom(roomInput());
    const first=hub.archiveRoom(room.id).archivedAt;
    expect(hub.archiveRoom(room.id).archivedAt).toBe(first);
  });
  it('survives a hub reconstruction', () => {
    const {db,hub}=setup(); const room=hub.createRoom(roomInput());
    expect(new Hub(db).getRoom(room.id).name).toBe('Team standup');
  });
});

describe('late automatic naming', () => {
  it('replaces a generated title that nobody has touched', () => {
    const {hub}=setup(); const generated='Zoom meeting 999 · 2026-09-12 11:25Z';
    const m=hub.ensureConversation('zoom','occurrence',generated);
    expect(hub.renameIfUnchanged(m.id,generated,'Vendor review · 2026-09-12 11:25Z').title)
      .toBe('Vendor review · 2026-09-12 11:25Z');
  });
  it('leaves a title a human chose while the lookup was in flight', () => {
    // The source learns Zoom's topic seconds after capture starts. A human who renamed in
    // that window must win, or automatic naming silently undoes deliberate naming.
    const {hub}=setup(); const generated='Zoom meeting 999 · 2026-09-12 11:25Z';
    const m=hub.ensureConversation('zoom','occurrence',generated);
    hub.renameConversation(m.id,'Attribution design');

    expect(hub.renameIfUnchanged(m.id,generated,'Vendor review').title).toBe('Attribution design');
  });
  it('rejects an empty automatic title rather than blanking a name', () => {
    const {hub}=setup(); const m=hub.ensureConversation('zoom','occurrence','Zoom meeting 999');
    expect(()=>hub.renameIfUnchanged(m.id,'Zoom meeting 999','   ')).toThrow();
    expect(hub.getConversation(m.id).title).toBe('Zoom meeting 999');
  });
});

describe('threads that follow a room', () => {
  const roomInput = () => ({
    name:'Team standup', sourceId:'zoom', externalId:'84680215093',
    joinUrl:'https://zoom.us/j/84680215093', hostUser:'operator@example.com',
  });
  const sitting = (hub: Hub, roomId: string, externalId: string) => {
    const c=hub.ensureConversation('zoom',externalId,`Team standup · ${externalId}`);
    hub.setConversationRoom(c.id,roomId); return c;
  };

  it('attaches to a room nobody has met in yet', () => {
    // A team attaches the thread when the room is made, not when someone first speaks.
    const {hub}=setup(); const room=hub.createRoom(roomInput());
    const attachment=hub.attachRoom('thread-a',room.id);
    expect(attachment).toEqual({threadId:'thread-a',roomId:room.id,conversationId:null,cursor:0});
  });
  it('resolves to the room’s latest sitting when attached', () => {
    const {hub}=setup(); const room=hub.createRoom(roomInput());
    sitting(hub,room.id,'occurrence-1'); const second=sitting(hub,room.id,'occurrence-2');
    expect(hub.attachRoom('thread-a',room.id).conversationId).toBe(second.id);
  });
  it('follows the room into a new sitting instead of going stale', () => {
    // This is the failure the room concept exists to fix: a thread attached to one sitting
    // stopped receiving anything the moment the room emptied and refilled, silently.
    const {hub}=setup(); const room=hub.createRoom(roomInput());
    const first=sitting(hub,room.id,'occurrence-1');
    hub.attachRoom('thread-a',room.id);
    expect(hub.getAttachment('thread-a')!.conversationId).toBe(first.id);

    const second=sitting(hub,room.id,'occurrence-2');
    expect(hub.getAttachment('thread-a')!.conversationId).toBe(second.id);
  });
  it('resets the cursor when it follows, because sequences restart per sitting', () => {
    const {hub}=setup(); const room=hub.createRoom(roomInput());
    const first=sitting(hub,room.id,'occurrence-1');
    hub.appendSegments(first.id,[segment('a'),segment('b')]);
    hub.attachRoom('thread-a',room.id); hub.acknowledge('thread-a',first.id,2);
    expect(hub.getAttachment('thread-a')!.cursor).toBe(2);

    sitting(hub,room.id,'occurrence-2');
    // Carrying cursor 2 across would mark the new sitting's opening as already read.
    expect(hub.getAttachment('thread-a')!.cursor).toBe(0);
  });
  it('leaves a thread attached to one sitting where it is', () => {
    // Attaching to a conversation is still a way of saying "this meeting, not the room".
    const {hub}=setup(); const room=hub.createRoom(roomInput());
    const first=sitting(hub,room.id,'occurrence-1');
    hub.attach('thread-a',first.id);

    sitting(hub,room.id,'occurrence-2');
    expect(hub.getAttachment('thread-a')).toEqual({threadId:'thread-a',roomId:null,conversationId:first.id,cursor:0});
  });
  it('does not disturb threads following a different room', () => {
    const {hub}=setup();
    const room=hub.createRoom(roomInput());
    const other=hub.createRoom({...roomInput(),externalId:'99900022233',name:'Vendor sync'});
    const mine=sitting(hub,room.id,'occurrence-1');
    hub.attachRoom('thread-a',room.id);

    sitting(hub,other.id,'occurrence-2');
    expect(hub.getAttachment('thread-a')!.conversationId).toBe(mine.id);
  });
  it('keeps the cursor when re-attaching to the same room', () => {
    const {hub}=setup(); const room=hub.createRoom(roomInput());
    const first=sitting(hub,room.id,'occurrence-1');
    hub.appendSegments(first.id,[segment('a')]);
    hub.attachRoom('thread-a',room.id); hub.acknowledge('thread-a',first.id,1);

    expect(hub.attachRoom('thread-a',room.id).cursor).toBe(1);
  });
  it('switching a thread from a room to a conversation clears the room', () => {
    const {hub}=setup(); const room=hub.createRoom(roomInput());
    const first=sitting(hub,room.id,'occurrence-1');
    hub.attachRoom('thread-a',room.id);
    expect(hub.attach('thread-a',first.id).roomId).toBeNull();

    sitting(hub,room.id,'occurrence-2');
    expect(hub.getAttachment('thread-a')!.conversationId).toBe(first.id);
  });
  it('detaches a room target', () => {
    const {hub}=setup(); const room=hub.createRoom(roomInput());
    hub.attachRoom('thread-a',room.id); hub.detach('thread-a');
    expect(hub.getAttachment('thread-a')).toBeNull();
  });
  it('rejects attaching to a room that does not exist', () => {
    const {hub}=setup();
    expect(()=>hub.attachRoom('thread-a','missing')).toThrow('Room not found');
  });
  it('survives a hub reconstruction', () => {
    const {db,hub}=setup(); const room=hub.createRoom(roomInput());
    hub.attachRoom('thread-a',room.id);
    expect(new Hub(db).getAttachment('thread-a')!.roomId).toBe(room.id);
  });
});

describe('registrants', () => {
  const roomInput = () => ({
    name:'Team standup', sourceId:'zoom', externalId:'84680215093',
    joinUrl:'https://zoom.us/j/84680215093', hostUser:'operator@example.com',
  });
  const person = (roomId: string, email='david@example.com') => ({
    roomId, name:'David Laing', email, externalId:`ext-${email}`,
    joinUrl:`https://zoom.us/w/84680215093?tk=${email}`,
  });

  it('stores a registrant against its room', () => {
    const {hub}=setup(); const room=hub.createRoom(roomInput());
    const stored=hub.createRegistrant(person(room.id));
    expect(stored).toMatchObject({roomId:room.id,name:'David Laing',email:'david@example.com'});
    expect(hub.listRegistrants(room.id).registrants.map(r=>r.id)).toEqual([stored.id]);
  });
  it('refuses a second live link for the same person in one room', () => {
    // Two live links for one person would make the participant list ambiguous about who is who.
    const {hub}=setup(); const room=hub.createRoom(roomInput());
    hub.createRegistrant(person(room.id));
    expect(()=>hub.createRegistrant(person(room.id))).toThrow();
  });
  it('keeps registrants of different rooms apart', () => {
    const {hub}=setup();
    const a=hub.createRoom(roomInput());
    const b=hub.createRoom({...roomInput(),externalId:'99900022233',name:'Vendor sync'});
    hub.createRegistrant(person(a.id));
    expect(hub.listRegistrants(b.id).registrants).toEqual([]);
  });
  it('rejects a registrant for a room that does not exist', () => {
    const {hub}=setup();
    expect(()=>hub.createRegistrant(person('missing'))).toThrow('Room not found');
  });
  it('records a renewed lifespan', () => {
    const {hub}=setup(); const room=hub.createRoom({...roomInput(),expiresAt:1_800_000_000_000});
    hub.createRegistrant(person(room.id));
    const renewed=hub.setRoomExpiry(room.id,1_960_000_000_000);

    expect(renewed.expiresAt).toBe(1_960_000_000_000);
    // Renewal restates the same Zoom meeting, so the links already issued are untouched.
    expect(hub.listRegistrants(room.id).registrants).toHaveLength(1);
    expect(hub.getRoom(room.id).joinUrl).toBe(roomInput().joinUrl);
  });
  it('retires a room whose meeting was deleted', () => {
    const {hub}=setup(); const room=hub.createRoom(roomInput());
    hub.createRegistrant(person(room.id));
    const deleted=hub.markRoomDeleted(room.id);

    expect(deleted.sourceDeletedAt).toBeGreaterThan(0);
    // Archived too: a room whose join URLs are dead should not be offered.
    expect(deleted.archivedAt).toBeGreaterThan(0);
    expect(hub.listRooms().rooms).toEqual([]);
    // The registrant list stays as the record of who was given a link that has been revoked.
    expect(hub.listRegistrants(room.id).registrants).toHaveLength(1);
  });
  it('keeps past sittings readable after the meeting is deleted', () => {
    const {hub}=setup(); const room=hub.createRoom(roomInput());
    const past=hub.ensureConversation('zoom','occurrence','Team standup · earlier');
    hub.setConversationRoom(past.id,room.id);
    hub.markRoomDeleted(room.id);

    expect(hub.getConversation(past.id).roomId).toBe(room.id);
    expect(hub.getRoom(room.id).name).toBe('Team standup');
  });
  it('records when a room stops working', () => {
    const {hub}=setup();
    const room=hub.createRoom({...roomInput(),expiresAt:1_900_000_000_000});
    expect(room.expiresAt).toBe(1_900_000_000_000);
    // A room created before expiry was tracked simply has none, rather than a wrong date.
    expect(hub.createRoom({...roomInput(),externalId:'77700033344'}).expiresAt).toBeNull();
  });
});
