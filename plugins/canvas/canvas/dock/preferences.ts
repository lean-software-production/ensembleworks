import type { AvTokenResult } from "../av.js";

export function avTokenFrom(value: unknown): AvTokenResult {
  if (typeof value !== "object" || value === null) {
    throw new Error("canvas_av_token returned something that is not a result");
  }
  const ok = Reflect.get(value, "ok");
  if (ok === false) {
    const detail = Reflect.get(value, "detail");
    return {
      ok: false,
      error: "not_configured",
      detail: typeof detail === "string" ? detail : "LiveKit is not configured.",
    };
  }
  const url = Reflect.get(value, "url");
  const token = Reflect.get(value, "token");
  const room = Reflect.get(value, "room");
  const identity = Reflect.get(value, "identity");
  if (ok !== true || typeof url !== "string" || typeof token !== "string" || typeof room !== "string" || typeof identity !== "string") {
    throw new Error("canvas_av_token returned a token this client cannot read");
  }
  return { ok: true, url, token, room, identity };
}
export function forgetRetiredPreferences(): void {
  try {
    for (const key of ["canvas-av-dock:position", "canvas-av-dock:collapsed"]) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Storage is optional in private or restricted browsing contexts.
  }
}
