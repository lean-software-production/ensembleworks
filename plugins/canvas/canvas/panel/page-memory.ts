import type { PageMemoryStore } from "../pages/last-page.js";

/** Resolve the browser store without letting privacy settings break mounting. */
export function pageMemoryStore(): PageMemoryStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
