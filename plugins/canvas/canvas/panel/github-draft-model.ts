import { indexBetween, type Shape } from "@ensembleworks/canvas-model";
import type { GithubRepoResponse, GithubIssueIdentity } from "../github-issue.js";
import { isValidatedRepo, parseGithubIssueUrl } from "../github-issue.js";

export interface IssueDraftPoint { readonly x: number; readonly y: number }
export type IssueLinkResult = { readonly state: "linked"; readonly identity: GithubIssueIdentity }
  | { readonly state: "cancelled" | "invalid_url" | "untracked" | "unavailable" };

/** Placement is unconditional: an unlinked card is already a shared canvas shape. */
export function createUnlinkedIssueShape(options: {
  point: IssueDraftPoint; pageId: string; siblings: readonly Shape[]; newId: () => string;
}): Shape {
  const top = options.siblings.reduce<string | null>((max, shape) => !max || shape.index > max ? shape.index : max, null);
  return {
    id: options.newId() as Shape["id"], kind: "github-issue", parentId: options.pageId as Shape["parentId"],
    index: indexBetween(top, null), x: options.point.x - 235, y: options.point.y - 128,
    rotation: 0, isLocked: false, opacity: 1, meta: {},
    props: { w: 470, h: 256, schemaVersion: 2 },
  };
}

/** Only validated project repositories may become a card's linked identity. */
export async function resolveIssueLink(options: {
  url: string; read: (repo: string) => Promise<GithubRepoResponse>; isCurrent: () => boolean;
}): Promise<IssueLinkResult> {
  const identity = parseGithubIssueUrl(options.url);
  if (!identity) return { state: "invalid_url" };
  const response = await options.read(identity.repo);
  if (!options.isCurrent()) return { state: "cancelled" };
  if (response.state === "untracked") return { state: "untracked" };
  if (!isValidatedRepo(response)) return { state: "unavailable" };
  return { state: "linked", identity };
}
