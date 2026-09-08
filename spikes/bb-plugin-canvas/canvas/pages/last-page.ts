// Per-client memory of the last page viewed in a room. This remains local:
// current page is view state, unlike the shared pages stored in the document.

export interface PageMemoryStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const LAST_PAGE_KEY_PREFIX = "canvas.lastPage.";

export function lastPageKey(roomId: string): string {
  return `${LAST_PAGE_KEY_PREFIX}${roomId}`;
}

export function readLastPage(
  store: PageMemoryStore | null,
  roomId: string,
): string | null {
  if (store === null) return null;
  let raw: string | null;
  try {
    raw = store.getItem(lastPageKey(roomId));
  } catch {
    return null;
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function writeLastPage(
  store: PageMemoryStore | null,
  roomId: string,
  pageId: string,
): void {
  if (store === null) return;
  const trimmed = pageId.trim();
  if (trimmed.length === 0) return;
  try {
    store.setItem(lastPageKey(roomId), trimmed);
  } catch {
    // Storage can be blocked or quota-limited; page navigation must still work.
  }
}
