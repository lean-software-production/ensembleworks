import type { BbPluginApi } from "@get-bb/plugin-sdk";

const MAX_IDS = 20;
const MAX_CACHE_ENTRIES = 100;
const CACHE_TTL_MS = 15_000;
const MAX_TEXT_LENGTH = 320;
const MAX_CONCURRENT = 4;
const DEADLINE_MS = 5_000;

type ThreadsOutput = Pick<BbPluginApi["sdk"]["threads"], "output">;

export interface ThreadExcerpt {
  readonly text: string;
  readonly label: "Latest response";
}

interface CacheEntry {
  readonly text: string;
  readonly expiresAt: number;
}

function excerptText(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= MAX_TEXT_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_TEXT_LENGTH - 1)}…`;
}

/**
 * Read small, linked-thread-only card excerpts from bb.
 *
 * Text is deliberately held only in this bounded, short-lived in-memory cache;
 * it is never written to plugin storage. The link check is repeated after the
 * SDK call because an unlink may race with a response in flight.
 */
export function createThreadExcerptReader(
  threads: ThreadsOutput,
  isLinked: (threadId: string) => boolean,
): (ids: readonly string[]) => Promise<Record<string, ThreadExcerpt>> {
  const cache = new Map<string, CacheEntry>();

  function cacheGet(threadId: string, now: number): string | null {
    const entry = cache.get(threadId);
    if (entry === undefined) return null;
    if (entry.expiresAt <= now) {
      cache.delete(threadId);
      return null;
    }
    // Keep recently used entries at the newest end of the bounded map.
    cache.delete(threadId);
    cache.set(threadId, entry);
    return entry.text;
  }

  function cacheSet(threadId: string, text: string, now: number): void {
    cache.delete(threadId);
    cache.set(threadId, { text, expiresAt: now + CACHE_TTL_MS });
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  async function readOne(threadId: string): Promise<ThreadExcerpt | null> {
    if (!isLinked(threadId)) return null;

    const cached = cacheGet(threadId, Date.now());
    if (cached !== null) {
      return { text: cached, label: "Latest response" };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
    try {
      const result = await threads.output({ threadId, signal: controller.signal });
      // Do not retain or return text after the link has disappeared while the
      // request was in flight.
      if (!isLinked(threadId) || result.output === null) return null;
      const text = excerptText(result.output);
      if (text.length === 0) return null;
      cacheSet(threadId, text, Date.now());
      return { text, label: "Latest response" };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return async (ids) => {
    const uniqueIds = [...new Set(ids)].slice(0, MAX_IDS);
    const result: Record<string, ThreadExcerpt> = {};
    let next = 0;

    async function worker(): Promise<void> {
      while (true) {
        const index = next++;
        if (index >= uniqueIds.length) return;
        const threadId = uniqueIds[index]!;
        const excerpt = await readOne(threadId);
        if (excerpt !== null) result[threadId] = excerpt;
      }
    }

    await Promise.all(
      Array.from(
        { length: Math.min(MAX_CONCURRENT, uniqueIds.length) },
        () => worker(),
      ),
    );
    return result;
  };
}

