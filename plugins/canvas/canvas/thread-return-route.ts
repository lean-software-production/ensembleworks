/** A return token addresses local view state; the page remains a normal deep link. */
export function parseThreadReturnRoute(subPath: string | null | undefined): {
  pagePath: string;
  token: string;
} | null {
  if (typeof subPath !== "string") return null;
  const match = /^\/?([^/]+)\/return\/([a-zA-Z0-9-]{1,80})\/?$/.exec(subPath.trim());
  return match ? { pagePath: match[1], token: match[2] } : null;
}

export function threadReturnSubPath(pageId: string, token: string): string {
  return `${encodeURIComponent(pageId)}/return/${token}`;
}
