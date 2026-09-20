import { indexBetween, type Shape } from "@ensembleworks/canvas-model";
import type { GithubRepoResponse } from "../github-issue.js";
import { isValidatedRepo, parseGithubIssueUrl } from "../github-issue.js";

export interface IssueDraftPoint { readonly x: number; readonly y: number }
export type IssueDraftResult = { readonly state: "created"; readonly shape: Shape }
  | { readonly state: "cancelled" } | { readonly state: "invalid_url" | "untracked" | "unavailable" };

/** No shared write occurs until URL, project membership, and the live draft token pass. */
export async function resolveIssueDraft(options: {
  url: string; point: IssueDraftPoint; pageId: string; siblings: readonly Shape[];
  read: (repo: string) => Promise<GithubRepoResponse>; isCurrent: () => boolean; newId: () => string;
}): Promise<IssueDraftResult> {
  const identity = parseGithubIssueUrl(options.url);
  if (!identity) return { state: "invalid_url" };
  const response = await options.read(identity.repo);
  if (!options.isCurrent()) return { state: "cancelled" };
  if (response.state === "untracked") return { state: "untracked" };
  if (!isValidatedRepo(response)) return { state: "unavailable" };
  const top = options.siblings.reduce<string | null>((max, shape) => !max || shape.index > max ? shape.index : max, null);
  return { state: "created", shape: {
    id: options.newId(), kind: "github-issue", parentId: options.pageId,
    index: indexBetween(top, null), x: options.point.x - 235, y: options.point.y - 128,
    rotation: 0, isLocked: false, opacity: 1, meta: {},
    props: { w: 470, h: 256, schemaVersion: 1, repo: identity.repo, number: identity.number },
  } as Shape };
}
