import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { githubPickerResponseSchema, githubRepoNameSchema, githubRepoResponseSchema, githubRepoWithBodyResponseSchema, type GithubPickerResponse, type GithubRepoResponse, type GithubRepoWithBodyResponse, type GithubStatusResponse } from "./github-issue.js";

const pluginStatusSchema = z.object({
  ghState: z.enum(["ready", "needs_configuration", "unavailable"]), repos: z.array(z.object({ repo: githubRepoNameSchema, projectId: z.string().nullable() })),
  lastSyncedAt: z.string().nullable(),
});
const pluginItemsSchema = z.object({ items: z.array(z.object({
  repo: githubRepoNameSchema, number: z.number().int().positive().safe(), kind: z.enum(["issue", "pr"]), title: z.string(),
  state: z.string(), author: z.string(), labels: z.array(z.string()), assignees: z.array(z.string()), updatedAt: z.string(), body: z.string(),
})) });

type Plugins = BbPluginApi["sdk"]["plugins"];

async function status(plugins: Plugins) {
  return plugins.callRpc({ pluginId: "github", method: "status", input: null, outputSchema: pluginStatusSchema });
}

export async function readGithubStatus(plugins: Plugins): Promise<GithubStatusResponse> {
  try {
    const result = await status(plugins); return { state: result.ghState, lastSyncedAt: result.lastSyncedAt };
  } catch {
    return { state: "unavailable", lastSyncedAt: null };
  }
}

/** Plain-text, bounded preview of the plugin's cached Markdown body. */
export function issueBodyPreview(body: string): string {
  const source = body.slice(0, 8192);
  const text = source.replace(/^\s*```[^\n]*$/gm, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/gm, "")
    .replace(/[*`~]/g, "")
    .replace(/\s+/g, " ").trim();
  return text.length > 4096 || body.length > source.length ? `${text.slice(0, 4096).trimEnd()}…` : text;
}

/** Every read checks the current Canvas project against GitHub's tracked repos. */
export function readGithubRepo(plugins: Plugins, projectId: string, requestedRepo: string): Promise<GithubRepoResponse>;
export function readGithubRepo(plugins: Plugins, projectId: string, requestedRepo: string, withBody: true): Promise<GithubRepoWithBodyResponse>;
export async function readGithubRepo(plugins: Plugins, projectId: string, requestedRepo: string, withBody = false): Promise<GithubRepoResponse | GithubRepoWithBodyResponse> {
  let result: Awaited<ReturnType<typeof status>>;
  try {
    result = await status(plugins);
  } catch {
    return { state: "plugin_unavailable", lastSyncedAt: null, issues: [] };
  }
  const tracked = result.repos.find((row) => row.projectId === projectId && row.repo.toLowerCase() === requestedRepo.toLowerCase());
  if (!tracked) return { state: "untracked", lastSyncedAt: result.lastSyncedAt, issues: [] };
  if (result.ghState !== "ready") return { state: result.ghState, lastSyncedAt: result.lastSyncedAt, issues: [] };
  try {
    const rows = await plugins.callRpc({ pluginId: "github", method: "listItems", input: { kind: "issue", repo: tracked.repo }, outputSchema: pluginItemsSchema });
    const issues = rows.items.filter((row) => row.kind === "issue" && row.repo.toLowerCase() === tracked.repo.toLowerCase()).map((row) => ({
      number: row.number, title: row.title, state: row.state, author: row.author, labels: row.labels, assignees: row.assignees, updatedAt: row.updatedAt,
      ...(withBody ? { bodyPreview: issueBodyPreview(row.body) } : {}),
    }));
    const response = { state: "ready", lastSyncedAt: result.lastSyncedAt, issues };
    return withBody ? githubRepoWithBodyResponseSchema.parse(response) : githubRepoResponseSchema.parse(response);
  } catch {
    return { state: "cache_error", lastSyncedAt: result.lastSyncedAt, issues: [] };
  }
}

/** Search only cached issues from repositories tracked by this Canvas project. */
export async function searchGithubIssues(plugins: Plugins, projectId: string, query: string): Promise<GithubPickerResponse> {
  let result: Awaited<ReturnType<typeof status>>;
  try { result = await status(plugins); }
  catch { return { state: "plugin_unavailable", lastSyncedAt: null, items: [] }; }
  if (result.ghState !== "ready") return { state: result.ghState, lastSyncedAt: result.lastSyncedAt, items: [] };
  const repos = result.repos.filter((row) => row.projectId === projectId);
  const responses = await Promise.allSettled(repos.map((row) => plugins.callRpc({ pluginId: "github", method: "listItems",
    input: { kind: "issue", repo: row.repo, query: query.trim() }, outputSchema: pluginItemsSchema })));
  const items = responses.flatMap((response, index) => response.status === "fulfilled"
    ? response.value.items.filter((item) => item.kind === "issue" && item.repo.toLowerCase() === repos[index]!.repo.toLowerCase())
      .map((item) => ({ repo: item.repo, number: item.number, title: item.title, state: item.state, updatedAt: item.updatedAt })) : []);
  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.repo.localeCompare(b.repo) || a.number - b.number);
  return githubPickerResponseSchema.parse({ state: responses.some((response) => response.status === "rejected") ? "cache_error" : "ready",
    lastSyncedAt: result.lastSyncedAt, items: items.slice(0, 20) });
}
