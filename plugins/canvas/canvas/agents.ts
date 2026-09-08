// The shape -> bb-thread links behind the agent-sticky loop: type a prompt into
// a note, run it, and that note carries a live status badge that opens the
// thread's real chat.
//
// DURABILITY. Links live in `bb.storage.kv` (one row per shape, key
// `agent:<shapeId>`) and are read back into memory once at load. kv rather than
// the plugin's SQLite because this is exactly what kv is for — a handful of
// small pointers, not a dataset — and rather than the canvas document itself
// because the document is a CRDT this plugin may not extend: putting a threadId
// in a shape's `meta` would be inventing a schema field that
// @ensembleworks/canvas-model does not define, and this spike consumes those
// packages without modifying them.
//
// WHY AN IN-MEMORY MIRROR. Two lookups need to be synchronous-ish and cheap:
// `bb.events.on("thread.idle")` fires for EVERY thread in the whole bb server
// and must answer "is this one of mine?" without a storage round trip per
// event, and that lookup is by threadId while the durable key is the shapeId.
// So the mirror holds both directions and kv holds the truth.
import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import {
  AGENT_STATUSES,
  type CanvasAgentLink,
  type CanvasAgentStatus,
} from "./wire.js";

/** kv key namespace. `bb.storage.kv` is already namespaced per plugin, so this
 * only separates agent links from any other key this plugin might keep. */
const KV_PREFIX = "agent:";

/** Longest title this plugin will give a spawned thread, per the brief. */
export const TITLE_LENGTH = 40;

/**
 * The thread title for a note's prompt: `Canvas: ` plus the first
 * TITLE_LENGTH characters. Whitespace is collapsed first — a note body is
 * multi-line by nature and a raw newline in a sidebar row is not a title.
 */
export function threadTitleFor(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return `Canvas: ${flat.length <= TITLE_LENGTH ? flat : flat.slice(0, TITLE_LENGTH)}`;
}

/** Validate one kv row. A row this does not recognize is DROPPED rather than
 * repaired: it can only come from a future or corrupted write, and a bad link
 * would mount a ThreadChat on a threadId that does not resolve. */
function linkFrom(value: unknown): CanvasAgentLink | null {
  if (typeof value !== "object" || value === null) return null;
  const link = value as Partial<CanvasAgentLink>;
  if (typeof link.shapeId !== "string" || link.shapeId.length === 0) return null;
  if (typeof link.threadId !== "string" || link.threadId.length === 0) return null;
  if (!(AGENT_STATUSES as readonly unknown[]).includes(link.status)) return null;
  return {
    shapeId: link.shapeId,
    threadId: link.threadId,
    status: link.status as CanvasAgentStatus,
  };
}

/**
 * The two fields of bb's `ThreadResponse` that say a thread has ENDED. Narrowed
 * to a local structural type rather than importing `ThreadResponse`: `sweep`
 * reads exactly these, and a two-field probe is something a test can hand over
 * without building a whole thread DTO.
 */
export interface ThreadLiveness {
  archivedAt: number | null;
  deletedAt: number | null;
}

export class AgentLinks {
  readonly #kv: PluginKvStorage;
  readonly #byShape = new Map<string, CanvasAgentLink>();
  readonly #shapeByThread = new Map<string, string>();

  constructor(kv: PluginKvStorage) {
    this.#kv = kv;
  }

  /** Read every persisted link into the mirror. Call once, in the factory —
   * this is what makes badges survive a plugin reload and a browser refresh. */
  async load(): Promise<void> {
    for (const key of await this.#kv.list(KV_PREFIX)) {
      const link = linkFrom(await this.#kv.get<unknown>(key));
      if (link !== null) this.#remember(link);
    }
  }

  get links(): CanvasAgentLink[] {
    return [...this.#byShape.values()];
  }

  linkForShape(shapeId: string): CanvasAgentLink | null {
    return this.#byShape.get(shapeId) ?? null;
  }

  /**
   * Which shape holds `threadId`, or null when no shape does — the reverse of
   * `linkForShape`, reading the same reverse index `apply` and `removeByThread`
   * already navigate by.
   *
   * ADDED FOR ATTACH, and it is the question the mirror's shape makes
   * unavoidable. `#shapeByThread` is keyed by thread, so one thread cannot
   * badge two shapes without the second silently stealing the first's events
   * (see canvas/agent-attach.ts's `other-shape`). Refusing that needs to know
   * who currently holds the thread, and only this class can answer it.
   */
  shapeForThread(threadId: string): string | null {
    return this.#shapeByThread.get(threadId) ?? null;
  }

  /**
   * Bind a shape to a thread at the given status, durably. Re-running a note
   * REPLACES its link: the previous thread is untouched in bb (it keeps its
   * history and its sidebar row) and simply stops being the one this note
   * points at. Deliberate — a note is one sticky with one current answer, and
   * a fan-out of orphan badges is worse than a thread you can still open from
   * the sidebar.
   */
  async record(
    shapeId: string,
    threadId: string,
    status: CanvasAgentStatus,
  ): Promise<CanvasAgentLink> {
    const link: CanvasAgentLink = { shapeId, threadId, status };
    this.#remember(link);
    await this.#kv.set(KV_PREFIX + shapeId, link);
    return link;
  }

  /**
   * Apply a bb thread lifecycle transition, or return null when `threadId` is
   * not one of ours — which is the common case, since thread events are
   * broadcast to every loaded plugin for every thread on the server.
   *
   * Unchanged statuses are re-published rather than deduped: a status message
   * is ephemeral (realtime is never replayed), so the cost of a redundant
   * publish is a few bytes and the cost of a suppressed one is a badge stuck on
   * the wrong colour until something else moves.
   */
  async apply(
    threadId: string,
    status: CanvasAgentStatus,
  ): Promise<CanvasAgentLink | null> {
    const shapeId = this.#shapeByThread.get(threadId);
    if (shapeId === undefined) return null;
    return this.record(shapeId, threadId, status);
  }

  /**
   * End a note's link, durably — the removal half of `record`. Returns the link
   * that was dropped so the caller can broadcast it, or null when the shape had
   * none, which is what makes an "unlink" of an already-unlinked note a no-op
   * rather than an error (two tabs can both press it, and the second press must
   * not fail).
   *
   * The THREAD is untouched: it keeps its history and its bb sidebar row and
   * simply stops being the one this note points at. Same reasoning as re-running
   * a note (see `record`) — this plugin owns the link, not the conversation.
   */
  async remove(shapeId: string): Promise<CanvasAgentLink | null> {
    const link = this.#byShape.get(shapeId);
    if (link === undefined) return null;
    this.#byShape.delete(shapeId);
    // The reverse entry goes too, or the orphaned thread's later idle/failed
    // events would re-create a badge on the note the user just cleared.
    this.#shapeByThread.delete(link.threadId);
    await this.#kv.delete(KV_PREFIX + shapeId);
    return link;
  }

  /**
   * End the link a thread is on, or return null when `threadId` is not one of
   * ours — the removal counterpart of `apply`, and the same null-is-normal
   * contract, since archive/delete events fire for every thread on the server.
   */
  async removeByThread(threadId: string): Promise<CanvasAgentLink | null> {
    const shapeId = this.#shapeByThread.get(threadId);
    if (shapeId === undefined) return null;
    return this.remove(shapeId);
  }

  /**
   * Drop every link whose thread has already ended, by asking bb about each one.
   * Returns the links it dropped.
   *
   * WHY THIS EXISTS. `thread.archived` / `thread.deleted` only reach a plugin
   * that is LOADED. A thread archived while bb was running without this plugin —
   * or between a crash and a restart — leaves a kv row pointing at a thread that
   * can no longer be opened, and nothing else would ever clear it.
   *
   * A PROBE FAILURE KEEPS THE LINK. `bb.sdk.threads.get` throws the same way for
   * "no such thread" and for "the call did not work", so a throw is not evidence
   * of anything; only an answer that explicitly carries `archivedAt`/`deletedAt`
   * drops a row. Erring towards a stale badge is right: a badge that should have
   * gone is a click that says "thread not found", whereas a badge wrongly
   * dropped destroys the only pointer from a note to its conversation.
   */
  async sweep(
    probe: (threadId: string) => Promise<ThreadLiveness>,
  ): Promise<CanvasAgentLink[]> {
    const dropped: CanvasAgentLink[] = [];
    for (const link of this.links) {
      let liveness: ThreadLiveness;
      try {
        liveness = await probe(link.threadId);
      } catch {
        continue;
      }
      if (liveness.archivedAt === null && liveness.deletedAt === null) continue;
      const removed = await this.remove(link.shapeId);
      if (removed !== null) dropped.push(removed);
    }
    return dropped;
  }

  #remember(link: CanvasAgentLink): void {
    const previous = this.#byShape.get(link.shapeId);
    // Drop the old reverse entry first, or a re-run would leave the SUPERSEDED
    // thread still mapped to this shape and its later idle/failed events would
    // keep overwriting the new thread's badge.
    if (previous !== undefined && previous.threadId !== link.threadId) {
      this.#shapeByThread.delete(previous.threadId);
    }
    this.#byShape.set(link.shapeId, link);
    this.#shapeByThread.set(link.threadId, link.shapeId);
  }
}
