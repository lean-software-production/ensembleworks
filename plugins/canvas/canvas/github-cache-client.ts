import { useEffect, useSyncExternalStore } from "react";
import type { RpcClient } from "./panel/connection-types.js";
import type { GithubPickerResponse, GithubRepoWithBodyResponse } from "./github-issue.js";

export interface RepoSnapshot {
  readonly current: GithubRepoWithBodyResponse | null; readonly lastGood: GithubRepoWithBodyResponse | null; readonly loading: boolean;
}
const EMPTY: RepoSnapshot = { current: null, lastGood: null, loading: false };

export class GithubCacheClient {
  private rpc: RpcClient | null = null; private generation = 0;
  private snapshots = new Map<string, RepoSnapshot>();
  private listeners = new Map<string, Set<() => void>>();
  private pending = new Map<string, Promise<GithubRepoWithBodyResponse>>();
  private lastCursor: string | null | undefined = undefined; private lastFocusRead = 0;

  configure(rpc: RpcClient | null) {
    this.rpc = rpc; this.generation++;
    this.pending.clear(); this.snapshots.clear(); this.lastCursor = undefined;
    for (const listeners of this.listeners.values()) for (const notify of listeners) notify();
    if (rpc) this.refreshAll();
  }

  get(repo: string): RepoSnapshot { return this.snapshots.get(repo.toLowerCase()) ?? EMPTY; }
  subscribe(repo: string, notify: () => void): () => void {
    const key = repo.toLowerCase();
    const listeners = this.listeners.get(key) ?? new Set<() => void>();
    listeners.add(notify); this.listeners.set(key, listeners);
    return () => { listeners.delete(notify); if (listeners.size === 0) this.listeners.delete(key); };
  }
  private set(repo: string, snapshot: RepoSnapshot) {
    const key = repo.toLowerCase();
    this.snapshots.set(key, snapshot); for (const notify of this.listeners.get(key) ?? []) notify();
  }
  async read(repo: string, force = false): Promise<GithubRepoWithBodyResponse> {
    const key = repo.toLowerCase();
    const pending = this.pending.get(key);
    if (pending) return pending;
    const previous = this.get(key);
    if (!force && previous.current?.state === "ready") return previous.current;
    const rpc = this.rpc;
    if (!rpc) return { state: "cache_error", lastSyncedAt: null, issues: [] };
    const generation = this.generation;
    this.set(key, { ...previous, loading: true });
    const task = rpc.call("canvas_github_repo_v2", { repo }).catch((): GithubRepoWithBodyResponse => ({
      state: "cache_error", lastSyncedAt: previous.current?.lastSyncedAt ?? null, issues: [],
    })).then((result) => {
      if (generation === this.generation) {
        const lastGood = result.state === "ready" ? result : previous.lastGood;
        this.set(key, { current: result, lastGood, loading: false }); this.pending.delete(key);
        if (result.state === "ready" && this.lastCursor === undefined) this.lastCursor = result.lastSyncedAt;
      }
      return result;
    });
    this.pending.set(key, task); return task;
  }
  async searchIssues(query: string): Promise<GithubPickerResponse> {
    if (!this.rpc) return { state: "plugin_unavailable", lastSyncedAt: null, items: [] };
    try { return await this.rpc.call("canvas_github_picker", { query: query.slice(0, 120) }); }
    catch { return { state: "cache_error", lastSyncedAt: null, items: [] }; }
  }
  refreshAll() { for (const repo of this.listeners.keys()) void this.read(repo, true); }
  refreshOnFocus() {
    if (Date.now() - this.lastFocusRead < 5_000) return;
    this.lastFocusRead = Date.now(); this.refreshAll();
  }
  async checkStatus() {
    const rpc = this.rpc;
    if (!rpc || this.listeners.size === 0) return;
    try {
      const status = await rpc.call("canvas_github_status", null);
      if (this.lastCursor === undefined) { this.lastCursor = status.lastSyncedAt; this.refreshAll(); return; }
      if (status.lastSyncedAt && status.lastSyncedAt !== this.lastCursor) {
        this.lastCursor = status.lastSyncedAt; this.refreshAll();
      }
    } catch { /* retain the last successful display until a later read */ }
  }
}

export const githubCache = new GithubCacheClient();

export function useGithubRepo(repo: string): RepoSnapshot {
  const snapshot = useSyncExternalStore((notify) => githubCache.subscribe(repo, notify), () => githubCache.get(repo), () => EMPTY);
  useEffect(() => { void githubCache.read(repo); }, [repo]);
  return snapshot;
}
