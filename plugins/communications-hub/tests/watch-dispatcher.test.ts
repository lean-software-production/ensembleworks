import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerConversationWatch } from '../src/watch-dispatcher';

type Watch = { threadId: string; conversationId: string; generation: string; processedCursor: number; lastAttemptAt: number | null };

function setup(initial: Partial<Watch> = {}) {
  const watch: Watch = { threadId: 'thread-1', conversationId: 'conversation-1', generation: 'generation-1', processedCursor: 0, lastAttemptAt: null, ...initial };
  let latest = 1;
  const events = new Map<string, (payload: any) => void>();
  let start: ((signal: AbortSignal) => Promise<void>) | undefined;
  let status: 'idle' | 'active' = 'idle';
  let getStarted: (() => void) | undefined;
  let getGate: Promise<void> | undefined;
  const sent: any[] = [];
  const hub = {
    listWatches: () => watch.generation ? [watch] : [],
    getWatch: () => watch.generation ? { ...watch } : null,
    stopWatch: (_threadId: string) => { watch.generation = ''; },
    latestSequence: () => latest,
    markWatchAttempt: (_threadId: string, generation: string, at: number) => {
      if (!watch.generation || watch.generation !== generation) return false;
      watch.lastAttemptAt = at;
      return true;
    },
    getAttachment: () => watch.generation ? { threadId: watch.threadId, conversationId: watch.conversationId } : null,
  };
  const bb = {
    events: { on: (name: string, callback: (payload: any) => void) => { events.set(name, callback); } },
    background: { service: (_name: string, definition: { start(signal: AbortSignal): Promise<void> }) => { start = definition.start; } },
    sdk: {
      threads: {
        get: async (): Promise<{id:string;status:'idle'|'active';archivedAt:number|null}> => {
          getStarted?.();
          await getGate;
          return { id: watch.threadId, status, archivedAt: null };
        },
        send: async (input: any) => { sent.push(input); return { ok: true, delivery: 'sent' }; },
      },
    },
  };
  return { watch, hub, bb, events, sent, setLatest: (value: number) => { latest = value; }, setStatus: (value: 'idle' | 'active') => { status = value; }, setGetStarted: (fn: () => void) => { getStarted = fn; }, setGetGate: (gate: Promise<void>) => { getGate = gate; }, getStart: () => start };
}

afterEach(() => vi.useRealTimers());

describe('conversation watch dispatcher', () => {
  it('sends one metadata-only wake for a watch with unprocessed passages', async () => {
    const s = setup();
    const dispatcher = registerConversationWatch(s.bb as any, s.hub as any);
    await dispatcher.sweep();
    expect(s.sent).toHaveLength(1);
    const text = s.sent[0].input[0].text as string;
    expect(text).toContain('conversation-1');
    expect(text).toContain('generation-1');
    expect(text).not.toContain('transcript text');
    expect(s.watch.lastAttemptAt).not.toBeNull();
    dispatcher.dispose();
  });

  it('coalesces a burst into a fixed 15-second window and wakes after idle', async () => {
    vi.useFakeTimers();
    const s = setup(); s.setStatus('active');
    const dispatcher = registerConversationWatch(s.bb as any, s.hub as any);
    s.events.get('thread.idle')!({ thread: { id: 'thread-1' } });
    s.events.get('thread.idle')!({ thread: { id: 'thread-1' } });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(s.sent).toHaveLength(0);
    s.setStatus('idle');
    s.events.get('thread.idle')!({ thread: { id: 'thread-1' } });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(s.sent).toHaveLength(1);
    dispatcher.dispose();
  });

  it('recovers a dropped notification through the service poll', async () => {
    vi.useFakeTimers();
    const s = setup();
    s.setLatest(0);
    const dispatcher = registerConversationWatch(s.bb as any, s.hub as any);
    const controller = new AbortController();
    const running = s.getStart()!(controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.sent).toHaveLength(0);
    // The signal is dropped; a new passage is discovered by the persisted poll.
    s.setLatest(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.sent).toHaveLength(1);
    controller.abort();
    await running;
    dispatcher.dispose();
  });

  it('leaves failed and unacknowledged work retryable behind the cooldown', async () => {
    const s = setup({ lastAttemptAt: Date.now() });
    const send = vi.fn(async () => { throw new Error('send failed'); });
    s.bb.sdk.threads.send = send;
    const dispatcher = registerConversationWatch(s.bb as any, s.hub as any);
    await dispatcher.sweep();
    expect(s.sent).toHaveLength(0);
    s.watch.lastAttemptAt = Date.now() - 60_001;
    await dispatcher.sweep();
    expect(s.sent).toHaveLength(0);
    expect(s.watch.lastAttemptAt).toBeGreaterThan(Date.now() - 1000);
    expect(send).toHaveBeenCalledTimes(1);
    await dispatcher.sweep();
    expect(send).toHaveBeenCalledTimes(1);
    s.watch.lastAttemptAt = Date.now() - 60_001;
    await dispatcher.sweep();
    expect(send).toHaveBeenCalledTimes(2);
    expect(s.sent).toHaveLength(0);
    dispatcher.dispose();
  });

  it('revalidates the watch after an asynchronous thread lookup', async () => {
    const s = setup();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const enteredGate = new Promise<void>(resolve => { entered = resolve; });
    s.setGetStarted(entered);
    s.setGetGate(gate);
    const dispatcher = registerConversationWatch(s.bb as any, s.hub as any);
    const pending = dispatcher.sweep();
    await enteredGate;
    s.hub.stopWatch('thread-1');
    release();
    await pending;
    expect(s.sent).toHaveLength(0);
    dispatcher.dispose();
  });

  it('stops archived watches and cleans the batching timer', async () => {
    vi.useFakeTimers();
    const s = setup();
    const dispatcher = registerConversationWatch(s.bb as any, s.hub as any);
    s.events.get('thread.archived')!({ thread: { id: 'thread-1' } });
    s.events.get('thread.idle')!({ thread: { id: 'thread-1' } });
    dispatcher.dispose();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(s.sent).toHaveLength(0);
  });

  it('stops a watch when polling discovers an archived thread', async () => {
    const s = setup();
    s.bb.sdk.threads.get = async () => ({ id: 'thread-1', status: 'idle', archivedAt: Date.now() });
    const dispatcher = registerConversationWatch(s.bb as any, s.hub as any);
    await dispatcher.sweep();
    expect(s.watch.generation).toBe('');
    expect(s.sent).toHaveLength(0);
    dispatcher.dispose();
  });

  it('does not start a sweep when the service is already aborted', async () => {
    const s = setup();
    const dispatcher = registerConversationWatch(s.bb as any, s.hub as any);
    const controller = new AbortController();
    controller.abort();
    await s.getStart()!(controller.signal);
    expect(s.sent).toHaveLength(0);
    dispatcher.dispose();
  });

  it('cancels the active poll wait on dispose', async () => {
    vi.useFakeTimers();
    const s = setup();
    const dispatcher = registerConversationWatch(s.bb as any, s.hub as any);
    const controller = new AbortController();
    const running = s.getStart()!(controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    dispatcher.dispose();
    await running;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.sent).toHaveLength(1);
  });
});
