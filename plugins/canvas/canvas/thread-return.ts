import { makeDocument, pageIdOf } from "@ensembleworks/canvas-model";
import type { Editor, Intent } from "@ensembleworks/canvas-editor";
import type { PageMemoryStore } from "./pages/last-page.js";

export const THREAD_RETURN_KEY = "canvas.threadReturns.v1";
const MAX_BOOKMARKS = 40;
const MAX_TOKEN = 200;
const MAX_TEXT = 300;
const MAX_SELECTION = 2_000;
const TOKEN_RE = /^[A-Za-z0-9-]{1,80}$/;
const MAX_RAW = 256 * 1024;
const MAX_COORDINATE = 1_000_000_000;
const MAX_ZOOM = 1_000_000;

export interface ReturnBookmark {
  readonly token: string;
  readonly threadId: string;
  readonly pageId: string;
  readonly pageName: string;
  readonly camera: { readonly x: number; readonly y: number; readonly z: number };
  readonly selection: readonly string[];
}

interface ReturnMemory {
  save(bookmark: ReturnBookmark): void;
  forThread(threadId: string): ReturnBookmark | null;
  visitsForThread(threadId: string): ReturnBookmark[];
  forToken(token: string): ReturnBookmark | null;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT;
}

function validCamera(value: unknown): value is ReturnBookmark["camera"] {
  if (typeof value !== "object" || value === null) return false;
  const camera = value as Record<string, unknown>;
  return (
    typeof camera.x === "number" && Number.isFinite(camera.x) && Math.abs(camera.x) <= MAX_COORDINATE &&
    typeof camera.y === "number" && Number.isFinite(camera.y) && Math.abs(camera.y) <= MAX_COORDINATE &&
    typeof camera.z === "number" && Number.isFinite(camera.z) && camera.z > 0 && camera.z <= MAX_ZOOM
  );
}

function parseBookmark(value: unknown): ReturnBookmark | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;
  if (!text(item.token) || item.token.length > MAX_TOKEN || !TOKEN_RE.test(item.token) || !text(item.threadId) || !text(item.pageId) || !text(item.pageName)) return null;
  if (!validCamera(item.camera) || !Array.isArray(item.selection) || item.selection.length > MAX_SELECTION) return null;
  if (!item.selection.every((id) => typeof id === "string" && id.length > 0 && id.length <= MAX_TEXT)) return null;
  return {
    token: item.token,
    threadId: item.threadId,
    pageId: item.pageId,
    pageName: item.pageName,
    camera: { x: item.camera.x, y: item.camera.y, z: item.camera.z },
    selection: [...item.selection],
  };
}

function parseList(raw: string | null): ReturnBookmark[] {
  if (raw === null) return [];
  if (raw.length > MAX_RAW) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.map(parseBookmark).filter((item): item is ReturnBookmark => item !== null).slice(-MAX_BOOKMARKS);
  } catch {
    return [];
  }
}

function boundedItems(items: readonly ReturnBookmark[]): ReturnBookmark[] {
  const next = items.slice(-MAX_BOOKMARKS).map((item) => ({ ...item, selection: [...item.selection] }));
  const encoded = () => JSON.stringify(next);
  while (next.length > 1 && encoded().length > MAX_RAW) next.shift();
  if (encoded().length <= MAX_RAW) return next;
  const only = next[0]!;
  let low = 0;
  let high = only.selection.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    only.selection = only.selection.slice(0, mid);
    if (encoded().length <= MAX_RAW) low = mid;
    else high = mid - 1;
  }
  only.selection = only.selection.slice(0, low);
  return next;
}

export function createReturnMemory(store: PageMemoryStore | null): ReturnMemory {
  let memory: ReturnBookmark[] = [];
  let storageUnavailable = store === null;

  const read = (): ReturnBookmark[] => {
    if (storageUnavailable || store === null) return memory;
    try {
      const parsed = parseList(store.getItem(THREAD_RETURN_KEY));
      memory = parsed;
      return parsed;
    } catch {
      storageUnavailable = true;
      return memory;
    }
  };

  const write = (items: ReturnBookmark[]): void => {
    memory = boundedItems(items);
    if (storageUnavailable || store === null) return;
    try {
      store.setItem(THREAD_RETURN_KEY, JSON.stringify(memory));
    } catch {
      storageUnavailable = true;
      // Keep the bounded in-memory copy usable when browser storage is blocked.
    }
  };

  return {
    save(bookmark) {
      const valid = parseBookmark(bookmark);
      if (valid === null) return;
      write([...read(), valid]);
    },
    forThread(threadId) {
      if (typeof threadId !== "string" || threadId.length === 0) return null;
      return [...read()].reverse().find((item) => item.threadId === threadId) ?? null;
    },
    visitsForThread(threadId) {
      const seen = new Set<string>();
      return [...read()].reverse().filter((item) => {
        if (item.threadId !== threadId) return false;
        const location = JSON.stringify([item.pageId, item.camera, [...item.selection].sort()]);
        if (seen.has(location)) return false;
        seen.add(location);
        return true;
      });
    },
    forToken(token) {
      if (typeof token !== "string" || token.length === 0) return null;
      return [...read()].reverse().find((item) => item.token === token) ?? null;
    },
  };
}

export function restoreThreadReturn(editor: Editor, bookmark: ReturnBookmark): boolean {
  if (!editor.doc.listPages().some((page) => page.id === bookmark.pageId)) return false;
  const snapshot = makeDocument({
    pages: editor.doc.listPages(),
    shapes: editor.doc.listShapes(),
    bindings: editor.doc.listBindings(),
    assets: editor.doc.listAssets(),
  });
  const selection = bookmark.selection.filter((id) => {
    const shape = snapshot.byId.get(id);
    return shape !== undefined && pageIdOf(snapshot, shape) === bookmark.pageId;
  });
  const intents: Intent[] = [
    { type: "SetCurrentPage" as const, pageId: bookmark.pageId },
    { type: "SetCamera" as const, ...bookmark.camera },
    { type: "SetSelection" as const, ids: selection },
  ];
  if (editor.get().editingId !== null) intents.push({ type: "EndEdit" as const });
  editor.applyAll(intents);
  return true;
}
