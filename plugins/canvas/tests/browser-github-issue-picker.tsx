import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { GithubIssueShape } from "../canvas/shapes/GithubIssueShape.js";
import { githubCache } from "../canvas/github-cache-client.js";

const items = Array.from({ length: 20 }, (_, index) => ({
  repo: "owner/repo", number: index + 1, title: `Issue ${index + 1}: picker result`,
  state: "OPEN", updatedAt: "2026-09-23T11:00:00Z",
}));

githubCache.configure({ call: async (method: string) => method === "canvas_github_picker"
  ? { state: "ready", lastSyncedAt: "2026-09-23T12:00:00Z", items }
  : { state: "ready", lastSyncedAt: null, issues: [] } } as any);

const card = document.getElementById("card")!;
const shape = { id: "shape:issue", kind: "github-issue", parentId: "page:p", index: "a1", x: 0, y: 0,
  rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { w: card.clientWidth, h: card.clientHeight, schemaVersion: 2 } };
createRoot(card).render(createElement(GithubIssueShape, { shape, dispatch: () => {} } as any));
