import { describe, expect, it, vi } from "vitest";
import { githubIssueUrl, isValidatedRepo, parseGithubIssueUrl } from "../canvas/github-issue.js";
import { readGithubRepo, readGithubStatus } from "../canvas/github-cache-server.js";
import { GithubCacheClient } from "../canvas/github-cache-client.js";
import { resolveIssueDraft } from "../canvas/panel/github-draft-model.js";
import { GithubIssueCard } from "../canvas/shapes/GithubIssueShape.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const status = {
  ghOk: true, ghState: "ready", ghError: null, lastSyncedAt: "2026-09-23T12:00:00Z",
  repos: [
    { repo: "Owner/Repo", projectId: "project:ours" },
    { repo: "other/repo", projectId: "project:other" },
    { repo: "extra/repo", projectId: null },
  ],
};
const item = {
  repo: "Owner/Repo", number: 42, kind: "issue", title: "Fix selection", state: "OPEN",
  author: "morgan", labels: ["bug"], assignees: ["alex"],
  url: "https://github.com/Owner/Repo/issues/42", body: "SECRET ISSUE BODY",
  updatedAt: "2026-09-23T09:15:00Z",
};

function plugin(fakeStatus: object = status, fakeItems: object = { items: [item] }) {
  const calls: string[] = [];
  const plugins = { callRpc: async ({ method, outputSchema }: any) => {
    calls.push(method);
    if (method === "status") return outputSchema.parse(fakeStatus);
    if (method === "listItems") return outputSchema.parse(fakeItems);
    throw new Error(`forbidden method ${method}`);
  } };
  return { plugins: plugins as any, calls };
}

describe("GitHub issue identity", () => {
  it("accepts canonical issue links and rejects hosts, extras and unsafe numbers", () => {
    expect(parseGithubIssueUrl(" https://github.com/Owner/Repo/issues/42/ ")).toEqual({ repo: "Owner/Repo", number: 42 });
    expect(githubIssueUrl({ repo: "Owner/Repo", number: 42 })).toBe("https://github.com/Owner/Repo/issues/42");
    for (const url of [
      "http://github.com/a/b/issues/1", "https://evil.test/a/b/issues/1", "https://github.com.evil.test/a/b/issues/1",
      "https://github.com/a/b/pull/1", "https://github.com/a/b/issues/0", "https://github.com/a/b/issues/1?x=1",
      "https://github.com/a/b/issues/9007199254740993", "https://github.com/../b/issues/1",
    ]) expect(parseGithubIssueUrl(url)).toBeNull();
  });
});

describe("project-scoped GitHub cache adapter", () => {
  it("projects only display fields and never returns body", async () => {
    const fake = plugin();
    const result = await readGithubRepo(fake.plugins, "project:ours", "owner/repo");
    expect(fake.calls).toEqual(["status", "listItems"]);
    expect(result.state).toBe("ready");
    expect(result.lastSyncedAt).toBe(status.lastSyncedAt);
    expect(result.issues.find((issue) => issue.number === 42)).toEqual({ number: 42, title: "Fix selection", state: "OPEN", author: "morgan", labels: ["bug"], assignees: ["alex"], updatedAt: item.updatedAt });
    expect(JSON.stringify(result)).not.toContain("SECRET ISSUE BODY");
  });
  it("refuses other projects and unowned extra repos before listItems", async () => {
    for (const repo of ["other/repo", "extra/repo", "untracked/repo"]) {
      const fake = plugin();
      expect((await readGithubRepo(fake.plugins, "project:ours", repo)).state).toBe("untracked");
      expect(fake.calls).toEqual(["status"]);
    }
  });
  it("distinguishes auth, unavailable, and a bounded cache miss", async () => {
    const needsAuth = plugin({ ...status, ghState: "needs_configuration", ghOk: false, ghError: "Login required" });
    expect((await readGithubRepo(needsAuth.plugins, "project:ours", "Owner/Repo")).state).toBe("needs_configuration");
    expect(needsAuth.calls).toEqual(["status"]);
    const miss = plugin(status, { items: [] });
    const result = await readGithubRepo(miss.plugins, "project:ours", "Owner/Repo");
    expect(result.state).toBe("ready");
    expect(result.issues.find((issue) => issue.number === 42)).toBeUndefined();
    const broken = { callRpc: async () => { throw new Error("offline"); } } as any;
    expect((await readGithubRepo(broken, "project:ours", "Owner/Repo")).state).toBe("plugin_unavailable");
    expect((await readGithubStatus(broken)).state).toBe("unavailable");
    expect(isValidatedRepo(await readGithubRepo(needsAuth.plugins, "project:ours", "Owner/Repo"))).toBe(true);
    expect(isValidatedRepo(await readGithubRepo(broken, "project:ours", "Owner/Repo"))).toBe(false);
  });
});

describe("per-repository Canvas cache", () => {
  it("deduplicates concurrent reads and preserves successful details on a later failure", async () => {
    let calls = 0;
    let fail = false;
    const client = new GithubCacheClient();
    client.configure({ call: async () => { calls++; if (fail) throw new Error("offline"); return { state: "ready", lastSyncedAt: status.lastSyncedAt, issues: [item] }; } } as any);
    await Promise.all([client.read("Owner/Repo"), client.read("owner/repo")]);
    expect(calls).toBe(1);
    fail = true;
    await client.read("Owner/Repo", true);
    expect(client.get("owner/repo").current?.state).toBe("cache_error");
    expect(client.get("owner/repo").lastGood?.issues[0]?.title).toBe("Fix selection");
    client.configure(null);
  });
  it("checks the shared global cursor and rereads each observed repo once when it advances", async () => {
    const calls: string[] = [];
    let cursor = "2026-09-23T12:00:00Z";
    const client = new GithubCacheClient();
    client.configure({ call: async (method: string, input: any) => {
      calls.push(`${method}:${input?.repo ?? ""}`);
      if (method === "canvas_github_status") return { state: "ready", lastSyncedAt: cursor };
      return { state: "ready", lastSyncedAt: cursor, issues: [] };
    } } as any);
    const offA = client.subscribe("Owner/Repo", () => {});
    const offB = client.subscribe("Other/Repo", () => {});
    await Promise.all([client.read("Owner/Repo"), client.read("Other/Repo")]);
    await client.checkStatus();
    expect(calls.filter((call) => call.startsWith("canvas_github_repo"))).toHaveLength(2);
    cursor = "2026-09-23T12:15:00Z";
    await client.checkStatus();
    await Promise.all([client.read("Owner/Repo"), client.read("Other/Repo")]);
    expect(calls.filter((call) => call.startsWith("canvas_github_repo"))).toHaveLength(4);
    offA(); offB(); client.configure(null);
  });
});

describe("issue draft commit boundary", () => {
  const base = { point: { x: 300, y: 200 }, pageId: "page:p", siblings: [],
    isCurrent: () => true, newId: () => "shape:new",
    read: async () => ({ state: "ready" as const, lastSyncedAt: status.lastSyncedAt, issues: [] }) };
  it("keeps invalid and untracked URLs out of the document", async () => {
    const read = vi.fn(base.read);
    expect((await resolveIssueDraft({ ...base, read, url: "https://evil.test/a/b/issues/42" })).state).toBe("invalid_url");
    expect(read).not.toHaveBeenCalled();
    expect((await resolveIssueDraft({ ...base, url: "https://github.com/other/repo/issues/42",
      read: async () => ({ state: "untracked", lastSyncedAt: null, issues: [] }) })).state).toBe("untracked");
  });
  it("cancels a pending validation without creating an id, then commits identity and layout only", async () => {
    let finish!: (value: any) => void;
    let current = true;
    const newId = vi.fn(() => "shape:new");
    const pending = resolveIssueDraft({ ...base, url: "https://github.com/Owner/Repo/issues/42",
      read: () => new Promise((resolve) => { finish = resolve; }), isCurrent: () => current, newId });
    current = false;
    finish({ state: "ready", lastSyncedAt: status.lastSyncedAt, issues: [] });
    expect(await pending).toEqual({ state: "cancelled" });
    expect(newId).not.toHaveBeenCalled();
    const committed = await resolveIssueDraft({ ...base, url: "https://github.com/Owner/Repo/issues/42", newId });
    expect(committed.state).toBe("created");
    if (committed.state !== "created") throw new Error("draft did not commit");
    expect(committed.shape.props).toEqual({ w: 470, h: 256, schemaVersion: 1, repo: "Owner/Repo", number: 42 });
    expect({ x: committed.shape.x, y: committed.shape.y }).toEqual({ x: 65, y: 72 });
  });
});

describe("issue card presentation and routing", () => {
  const shape = { id: "shape:issue", kind: "github-issue", parentId: "page:p", index: "a1", x: 0, y: 0,
    rotation: 0, isLocked: false, opacity: 1, meta: {},
    props: { w: 260, h: 170, schemaVersion: 1, repo: "Owner/Repo", number: 42 } } as any;
  const render = (current: any, lastGood: any = null) => renderToStaticMarkup(createElement(GithubIssueCard, {
    shape, repoSnapshot: { current, lastGood, loading: false },
  }));
  const ready = { state: "ready", lastSyncedAt: status.lastSyncedAt, issues: [item] };
  it("keeps the only navigation on the issue number while the card body remains selectable", () => {
    const html = render(ready);
    expect(html).toContain('href="https://github.com/Owner/Repo/issues/42"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('data-canvas-interactive=""');
    expect(html).toContain('data-shape-body="github-issue"');
    expect(html).toContain("Fix selection");
    const card = GithubIssueCard({ shape, repoSnapshot: { current: ready as any, lastGood: null, loading: false } }) as any;
    const header = card.props.children[0];
    const link = header.props.children[1];
    const stopped = vi.fn();
    link.props.onPointerDown({ stopPropagation: stopped });
    link.props.onClick({ stopPropagation: stopped });
    expect(stopped).toHaveBeenCalledTimes(2);
    expect(card.props["data-canvas-interactive"]).toBeUndefined();
  });
  it("shows a cache miss honestly and keeps last successful details visibly stale on read failure", () => {
    const miss = render({ ...ready, issues: [] });
    expect(miss).toContain("Not in GitHub cache");
    expect(miss).not.toContain("deleted");
    expect(miss).toContain('href="https://github.com/Owner/Repo/issues/42"');
    const stale = render({ state: "cache_error", lastSyncedAt: status.lastSyncedAt, issues: [] }, ready);
    expect(stale).toContain("Fix selection");
    expect(stale).toContain("details may be stale");
    expect(stale).toContain("GitHub cache read failed");
  });
  it("stacks both labeled timestamps within the 260px compact footer", () => {
    const html = render(ready);
    const footer = html.match(/<footer style="([^"]+)">([^<]*(?:<[^>]+>[^<]*)*)<\/footer>/)?.[0] ?? "";
    expect(footer).toContain("display:grid");
    expect(footer).toContain("white-space:normal");
    expect(footer).toContain("Issue updated");
    expect(footer).toContain("GitHub sync");
    expect(footer).toContain("latest global GitHub plugin sync");
  });
});
