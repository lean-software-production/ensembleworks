import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub } from '../src/hub';

const databases: Database.Database[] = [];
function setup() { const db = new Database(':memory:'); databases.push(db); return {db, hub: new Hub(db)}; }
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const passage = (key: string) => ({sourceKey:key,speaker:null,text:`passage ${key}`,startMs:null,endMs:null});

describe('conversation watch storage', () => {
  it('persists a watch and keeps start idempotent', () => {
    const {db,hub}=setup(); const c=hub.ensureConversation('import','one','One'); hub.attach('thread',c.id);
    hub.appendSegments(c.id,[passage('a')]);
    const first=hub.startWatch('thread'); expect(first.processedCursor).toBe(0); expect(first.lastAttemptAt).toBeNull();
    expect(hub.startWatch('thread')).toEqual(first);
    expect(new Hub(db).getWatch('thread')).toEqual(first);
  });

  it('isolates watches and validates acknowledgements against the generation and transcript', () => {
    const {hub}=setup(); const c=hub.ensureConversation('import','one','One'); hub.appendSegments(c.id,[passage('a'),passage('b')]);
    hub.attach('a',c.id); hub.attach('b',c.id); const a=hub.startWatch('a'); const b=hub.startWatch('b');
    expect(hub.acknowledgeWatch('a',c.id,a.generation,1).processedCursor).toBe(1);
    expect(hub.getWatch('b')).toEqual(b);
    expect(() => hub.acknowledgeWatch('a',c.id,'old',2)).toThrow(/generation/i);
    expect(() => hub.acknowledgeWatch('a',c.id,a.generation,3)).toThrow(/available/i);
    expect(hub.getWatch('a')!.processedCursor).toBe(1);
    expect(hub.latestSequence(c.id)).toBe(2);
  });

  it('stops on detach and changing attachment, while preserving same-attachment starts', () => {
    const {hub}=setup(); const one=hub.ensureConversation('import','one','One'); const two=hub.ensureConversation('import','two','Two');
    hub.attach('thread',one.id); const first=hub.startWatch('thread'); hub.attach('thread',one.id); expect(hub.getWatch('thread')).toEqual(first);
    hub.attach('thread',two.id); expect(hub.getWatch('thread')).toBeNull();
    const second=hub.startWatch('thread'); expect(second.generation).not.toBe(first.generation);
    hub.detach('thread'); expect(hub.getWatch('thread')).toBeNull();
  });

  it('stops on room rollover and rejects watching a room without a current conversation', () => {
    const {hub}=setup(); const room=hub.createRoom({name:'Room',sourceId:'zoom',externalId:'room',joinUrl:'https://example.test',hostUser:'host'});
    expect(() => hub.startWatch('thread')).toThrow(/attached/i);
    hub.attachRoom('thread',room.id); expect(() => hub.startWatch('thread')).toThrow(/attached/i);
    const first=hub.ensureConversation('zoom','one','One'); hub.setConversationRoom(first.id,room.id);
    expect(hub.attachRoom('thread',room.id).conversationId).toBe(first.id); const watch=hub.startWatch('thread');
    const second=hub.ensureConversation('zoom','two','Two'); hub.setConversationRoom(second.id,room.id);
    expect(hub.getWatch('thread')).toBeNull(); expect(watch.generation).not.toBe(hub.startWatch('thread').generation);
  });

  it('updates attempt timestamps only for the current generation', () => {
    const {hub}=setup(); const c=hub.ensureConversation('import','one','One'); hub.attach('thread',c.id); const watch=hub.startWatch('thread');
    expect(hub.markWatchAttempt('thread','old',100)).toBe(false); expect(hub.getWatch('thread')!.lastAttemptAt).toBeNull();
    expect(hub.markWatchAttempt('thread',watch.generation,100)).toBe(true); expect(hub.getWatch('thread')!.lastAttemptAt).toBe(100);
  });
});
