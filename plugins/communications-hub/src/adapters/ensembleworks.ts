import { randomUUID, createHash } from 'node:crypto';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import type { TranscriptSink, SegmentInput } from '../domain';

const LIMIT = 10_000;
const MAX_BYTES = 16 * 1024 * 1024;
const OVERLAP_MS = 60_000;
const KEY = 'ensembleworks:capture';
// Poll quickly while speech is arriving, and back off to IDLE_POLL_MAX_MS while
// it isn't (or while the source is failing). Every V1 poll costs the sync
// server a transcript read, and an idle room with capture left on otherwise
// polls the same overlap window every 2s forever.
export const POLL_MS = 2000;
export const IDLE_POLL_MAX_MS = 30_000;
export function nextPollDelay(previous: number, progressed: boolean) {
  return progressed ? POLL_MS : Math.min(Math.max(previous, POLL_MS) * 2, IDLE_POLL_MAX_MS);
}
// Global setTimeout rather than node:timers/promises, so tests can fake the cadence.
function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, {once: true});
  });
}
const responseSchema = z.object({ ok: z.literal(true), now: z.number().int().nonnegative(),
  entries: z.array(z.object({ id: z.string().min(1).max(256), t: z.number().int().nonnegative(),
    identity: z.string().min(1).max(200), name: z.string().max(200),
    text: z.string().min(1).max(4000) })).max(LIMIT),
});
interface Capture {
  conversationId: string; url: string; room: string; since: number; anchor: number; enabled: boolean;
}
export function transcriptUrl(base: string, room: string, since: number) {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP(S) server URL without credentials, query or fragment.');
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}/api/scribe/transcript`;
  url.search = new URLSearchParams({ room, since: String(since), limit: String(LIMIT) }).toString();
  return url;
}
async function readResponse(response: Response) {
  if (!response.ok || !response.body) throw new Error('Source unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('Source response exceeds capture limit');
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return responseSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
export async function registerEnsembleWorks(bb: BbPluginApi, hub: TranscriptSink, request: typeof fetch = fetch) {
  let capture = await bb.storage.kv.get<Capture>(KEY);
  let pending: Promise<unknown> = Promise.resolve();
  const lifetime = new AbortController();
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = pending.then(fn); pending = next.catch(() => {}); return next;
  }
  // Resolves true when the cursor advanced, i.e. new speech arrived.
  async function poll(): Promise<boolean> {
    if (!capture?.enabled || lifetime.signal.aborted) return false;
    const current = capture;
    try {
      const page = await readResponse(await request(transcriptUrl(current.url, current.room,
        Math.max(current.anchor, current.since - OVERLAP_MS)), {
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]), redirect: 'error',
      }));
      if (lifetime.signal.aborted) return false;
      // The V1 API returns a tail, not a forward page. A full result may have
      // dropped earlier entries, so never advance over it as if it were complete.
      if (page.entries.length === LIMIT) throw new Error('Source tail saturated');
      const segments: SegmentInput[] = [];
      let since = current.since;
      for (const entry of page.entries) {
        if (entry.t > page.now) throw new Error('Source speech is ahead of its clock');
        since = Math.max(since, entry.t);
        for (let offset = 0; offset < entry.text.length; offset += 2000) {
          const text = entry.text.slice(offset, offset + 2000);
          if (text.trim()) segments.push({sourceKey: `${createHash('sha256').update(entry.id).digest('hex')}:${offset}`,
            speaker: entry.name || entry.identity, speakerId: entry.identity, text,
            startMs: Math.max(0, entry.t - current.anchor), endMs: null});
        }
      }
      // Each append is transactional; retries deduplicate across batches if a
      // later batch or the checkpoint write fails.
      for (let i=0; i<segments.length; i+=1000) hub.appendSegments(current.conversationId, segments.slice(i,i+1000));
      const next = {...current, since};
      await bb.storage.kv.set(KEY, next);
      if (lifetime.signal.aborted) return false;
      capture = next;
      hub.setCapture(current.conversationId, 'capturing', 'Following V1 transcripts with a 60-second overlap; older late arrivals and upstream audio gaps cannot be detected.');
      return since > current.since;
    } catch {
      if (!lifetime.signal.aborted) hub.setCapture(current.conversationId, 'interrupted',
        'V1 transcript unavailable, invalid, or catch-up exceeds 10,000 entries / 16 MiB. Cursor retained; retrying.');
      return false;
    }
  }
  // Aborted by start() so a loop that backed off while capture was off wakes
  // into the fast cadence instead of sleeping out up to IDLE_POLL_MAX_MS.
  let wake = new AbortController();
  bb.background.service('ensembleworks-transcript', {async start(signal) {
    let wait = POLL_MS; let woken = false;
    while (!signal.aborted && !lifetime.signal.aborted) {
      // start() has just polled, so a woken loop waits POLL_MS before the next.
      wait = woken ? POLL_MS : nextPollDelay(wait, await exclusive(poll));
      woken = false;
      const waking = wake.signal;
      try { await delay(wait, AbortSignal.any([signal, waking])); } catch {
        if (signal.aborted || !waking.aborted) break;
        wake = new AbortController(); woken = true;
      }
    }
  }});
  bb.onDispose(async () => {
    lifetime.abort(); await pending;
    if (capture?.enabled) hub.setCapture(capture.conversationId, 'interrupted', 'V1 capture resumes when the plugin restarts.');
  });
  return {
    start: (url: string, room: string, title: string, since: number) => exclusive(async () => {
      transcriptUrl(url, room, since);
      z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).parse(room);
      z.number().int().nonnegative().parse(since);
      z.string().trim().min(1).max(200).parse(title);
      if (capture?.enabled) {
        if (capture.url !== url || capture.room !== room) throw new Error('Stop the existing V1 capture before changing sources.');
        return {conversationId: capture.conversationId};
      }
      const source = createHash('sha256').update(`${url}\n${room}`).digest('hex');
      const conversation = hub.ensureConversation('ensembleworks', `${source}:${randomUUID()}`, title);
      const next: Capture = {conversationId:conversation.id,url,room,since,anchor:since,enabled:true};
      await bb.storage.kv.set(KEY,next); capture=next;
      hub.setCapture(conversation.id,'connecting','Waiting for the V1 transcript.');
      await poll(); wake.abort(); return {conversationId:conversation.id};
    }),
    stop: (conversationId: string) => exclusive(async () => {
      if (capture?.conversationId !== conversationId || !capture.enabled) return;
      const next = {...capture, enabled:false}; await bb.storage.kv.set(KEY,next); capture=next;
      hub.setCapture(conversationId,'stopped','V1 capture stopped locally.');
    }),
    status: () => ({enabled:capture?.enabled ?? false, conversationId:capture?.conversationId ?? null}),
  };
}
