import { z } from "zod";

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface GithubIssueIdentity { readonly repo: string; readonly number: number }

/** Parse the URL before any shared write. URL normalization must not hide extra paths. */
export function parseGithubIssueUrl(raw: string): GithubIssueIdentity | null {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/([1-9][0-9]*)\/?$/.exec(raw.trim());
  if (!match || match[1] === "." || match[1] === ".." || match[2] === "." || match[2] === "..") return null;
  const number = Number(match[3]);
  return Number.isSafeInteger(number) ? { repo: `${match[1]}/${match[2]}`, number } : null;
}

export function githubIssueUrl(identity: GithubIssueIdentity): string {
  if (!REPO.test(identity.repo) || identity.repo.split("/").some((part) => part === "." || part === "..") || !Number.isSafeInteger(identity.number) || identity.number <= 0) throw new Error("invalid GitHub issue identity");
  return `https://github.com/${identity.repo}/issues/${identity.number}`;
}

export const githubDisplayIssueSchema = z.object({
  number: z.number().int().positive(), title: z.string(), state: z.string(), author: z.string(),
  labels: z.array(z.string()), assignees: z.array(z.string()), updatedAt: z.string(),
}).strict();

export const githubRepoResponseSchema = z.object({
  state: z.enum(["ready", "needs_configuration", "unavailable", "plugin_unavailable", "cache_error", "untracked"]),
  lastSyncedAt: z.string().nullable(),
  issues: z.array(githubDisplayIssueSchema),
}).strict();
export type GithubRepoResponse = z.infer<typeof githubRepoResponseSchema>;
export const isValidatedRepo = (response: GithubRepoResponse): boolean => response.state === "ready" || response.state === "needs_configuration" || response.state === "unavailable";

export const githubStatusResponseSchema = z.object({
  state: z.enum(["ready", "needs_configuration", "unavailable"]),
  lastSyncedAt: z.string().nullable(),
}).strict();
export type GithubStatusResponse = z.infer<typeof githubStatusResponseSchema>;
