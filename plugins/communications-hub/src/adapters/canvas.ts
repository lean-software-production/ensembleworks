import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import type { TranscriptSink, SegmentInput } from '../domain';

// The Canvas plugin is the durable receiving end of the existing LiveKit scribe.
// Keep its wire format here; the hub knows only conversations and segments.
export const canvasFeedSchema = z.object({
  streamId: z.string().min(1).max(128),
  entries: z.array(z.object({ id: z.number().int().positive(), ts: z.number().int().nonnegative(),
    speaker: z.string().min(1).max(200), text: z.string().min(1).max(10_000) })).max(100),
  hasMore: z.boolean(), nextCursor: z.number().int().nonnegative(),
});
interface Capture {
  conversationId: string; streamId: string | null; cursor: number;
  anchor: number | null; enabled: boolean;
}
const KEY = 'canvas:capture';

export async function registerCanvas(bb: BbPluginApi, hub: TranscriptSink) {
  let capture = await bb.storage.kv.get<Capture>(KEY);
  let disposed = false;
  // Serialize start/stop/poll so a stopped or replaced capture cannot receive an in-flight page.
  let pending: Promise<unknown> = Promise.resolve();
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = pending.then(fn);
    pending = result.catch(() => {});
    return result;
  }
  async function poll() {
    if (disposed || !capture?.enabled) return false;
    const current = capture;
    try {
      const page = canvasFeedSchema.parse(await bb.sdk.plugins.callRpc({
        pluginId: 'canvas', method: 'canvas_transcript_feed',
        input: { after: current.cursor, limit: 100 }, outputSchema: canvasFeedSchema,
      }));
      if (disposed) return false;
      if (current.streamId && page.streamId !== current.streamId) {
        throw new Error('Source transcript storage changed');
      }
      let previous = current.cursor;
      for (const entry of page.entries) {
        if (entry.id <= previous) throw new Error('Invalid source cursor');
        previous = entry.id;
      }
      if (page.nextCursor !== previous || (page.hasMore && !page.entries.length)) throw new Error('Invalid source page');
      // Save the anchor before appending: a crash/replay must use identical timings and keys.
      const anchored = { ...current, streamId: page.streamId,
        anchor: current.anchor ?? page.entries[0]?.ts ?? null };
      await bb.storage.kv.set(KEY, anchored);
      if (disposed) return false;
      capture = anchored;
      const segments: SegmentInput[] = [];
      for (const entry of page.entries) {
        for (let offset = 0; offset < entry.text.length; offset += 2000) {
          const text = entry.text.slice(offset, offset + 2000);
          if (!text.trim()) continue;
          segments.push({ sourceKey: `${page.streamId}:${entry.id}:${offset / 2000}`,
            speaker: entry.speaker, speakerId: null, text,
            startMs: anchored.anchor !== null && entry.ts >= anchored.anchor ? entry.ts - anchored.anchor : null,
            endMs: null });
        }
      }
      // Append before advancing the cursor. Retrying after a crash deduplicates in the hub.
      if (segments.length) hub.appendSegments(current.conversationId, segments);
      const advanced = { ...anchored, cursor: page.nextCursor };
      await bb.storage.kv.set(KEY, advanced);
      if (disposed) return false;
      capture = advanced;
      hub.setCapture(current.conversationId, 'capturing', 'Following the Canvas transcript store; upstream audio coverage is unknown.');
      return page.hasMore;
    } catch {
      if (!disposed) hub.setCapture(current.conversationId, 'interrupted', 'Canvas transcript feed unavailable or changed. Retrying from the saved cursor.');
      return false;
    }
  }
  async function start(title: string) {
    return exclusive(async () => {
      if (capture?.enabled) return { conversationId: capture.conversationId };
      const conversation = hub.ensureConversation('canvas', randomUUID(), title);
      const next: Capture = { conversationId: conversation.id, streamId: null, cursor: 0, anchor: null, enabled: true };
      await bb.storage.kv.set(KEY, next);
      capture = next;
      hub.setCapture(conversation.id, 'connecting', 'Waiting for the Canvas transcript feed.');
      await poll();
      return { conversationId: conversation.id };
    });
  }
  async function stop(conversationId: string) {
    return exclusive(async () => {
      if (capture?.conversationId !== conversationId || !capture.enabled) return;
      const next = { ...capture, enabled: false };
      await bb.storage.kv.set(KEY, next);
      capture = next;
      hub.setCapture(conversationId, 'stopped', 'Canvas capture stopped locally.');
    });
  }
  bb.background.service('canvas-transcript', { async start(signal) {
    while (!signal.aborted && !disposed) {
      const more = await exclusive(poll);
      try { await delay(more ? 10 : 2000, undefined, { signal }); }
      catch { break; }
    }
  } });
  bb.onDispose(async () => {
    disposed = true;
    await pending;
    if (capture?.enabled) hub.setCapture(capture.conversationId, 'interrupted', 'Canvas capture will resume when the plugin restarts.');
  });
  return { start, stop, status: () => ({ enabled: capture?.enabled ?? false,
    conversationId: capture?.conversationId ?? null, cursor: capture?.cursor ?? 0 }) };
}
