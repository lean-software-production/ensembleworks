import type { ContentScriptRpc } from "./rpc.js";
import { clientSideTook } from "./navigate.js";
import { MAX_PATH_LENGTH, parseLocation, type BbLocation } from "./where.js";
import { parseRoster, type DockRosterEntry } from "./model.js";
import { tabClientId } from "../tab-id.js";

export interface DockRoute {
  readonly current: () => BbLocation | null;
  readonly roster: () => readonly DockRosterEntry[];
  readonly refresh: () => Promise<void>;
  readonly check: () => void;
  readonly jumpTo: (path: string) => void;
}
export interface DockRouteOptions {
  readonly rpc: ContentScriptRpc;
  readonly isDisposed: () => boolean;
  readonly selfIdentity: () => string | null;
  readonly render: () => void;
  readonly onLocation: (location: BbLocation | null) => void;
}

export function createDockRoute(options: DockRouteOptions): DockRoute {
  let polledRoster: readonly DockRosterEntry[] = [];
  let here: BbLocation | null = null;
  let herePath: string | null = null;

  const report = () => {
    const result: { clientId: string; name?: string; path?: string; title?: string; focused: boolean } = {
      clientId: tabClientId(),
      focused: document.hasFocus(),
    };
    const name = options.selfIdentity();
    if (name !== null) result.name = name;
    const path = window.location.pathname;
    if (path.startsWith("/") && !path.startsWith("//") && path.length <= MAX_PATH_LENGTH) {
      result.path = path;
    }
    const title = document.title.trim();
    if (title.length > 0) result.title = title.slice(0, 200);
    return result;
  };

  const refresh = async (): Promise<void> => {
    if (options.isDisposed()) return;
    try {
      polledRoster = parseRoster(await options.rpc.call("canvas_roster", report()));
      options.render();
    } catch {
      // Keep the last good membership answer; the next poll retries.
    }
  };

  const check = (): void => {
    if (options.isDisposed()) return;
    const path = window.location.pathname;
    if (path === herePath) return;
    herePath = path;
    here = parseLocation(path);
    options.onLocation(here);
    void refresh();
    options.render();
  };

  const jumpTo = (path: string): void => {
    const before = { path: window.location.pathname, title: document.title };
    try {
      window.history.pushState({}, "", path);
      window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
    } catch {
      window.location.assign(path);
      return;
    }
    let attempt = 0;
    const verify = (): void => {
      if (options.isDisposed()) return;
      const after = { path: window.location.pathname, title: document.title };
      if (clientSideTook(before, after, path)) {
        check();
        return;
      }
      attempt += 1;
      if (attempt === 1) requestAnimationFrame(verify);
      else if (attempt === 2) window.setTimeout(verify, 150);
      else window.location.replace(path);
    };
    requestAnimationFrame(verify);
  };

  return { current: () => here, roster: () => polledRoster, refresh, check, jumpTo };
}
