// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { githubIssuePickerKeyboard as contract } from "../../../interaction-contracts/src/index.js";
import { GithubIssueShape } from "../canvas/shapes/GithubIssueShape.js";
import { githubCache } from "../canvas/github-cache-client.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { githubCache.configure(null); document.body.replaceChildren(); });

it(`interaction contract: ${contract.name}`, async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), dispatch = vi.fn();
  githubCache.configure({ call: async (method: string) => method === "canvas_github_picker"
    ? { state: "ready", lastSyncedAt: "2026-09-23T12:00:00Z", items: [{ repo: "owner/repo", number: 42,
      title: contract.option, state: "OPEN", updatedAt: "2026-09-23T11:00:00Z" }] }
    : { state: "ready", lastSyncedAt: null, issues: [] } } as any);
  const shape = { id: "shape:issue", kind: "github-issue", parentId: "page:p", index: "a1", x: 0, y: 0,
    rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { w: 470, h: 256, schemaVersion: 2 } };
  await act(async () => root.render(createElement(GithubIssueShape, { shape, dispatch } as any)));
  const input = host.querySelector<HTMLInputElement>('[role="combobox"]');
  expect(input, "unlinked card must expose an issue search combobox").not.toBeNull();
  await act(async () => {
    input!.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, contract.query);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
  expect(document.querySelector('[role="listbox"]')?.textContent).toContain(contract.option);
  for (const key of contract.keys) await act(async () => input!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
  const linkedUrl = dispatch.mock.calls[0]?.[0]?.[0]?.props?.issueUrl ?? null;
  expect(contract.check({ combobox: Boolean(input), options: [contract.option], linkedUrl })).toBeNull();
  expect(dispatch).toHaveBeenCalledWith([{ type: "UpdateProps", id: shape.id, props: { issueUrl: contract.issueUrl } }]);
  await act(async () => root.unmount());
});

it("links a cached issue by pointer without putting search text into shared shape props", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), dispatch = vi.fn();
  githubCache.configure({ call: async (method: string) => method === "canvas_github_picker"
    ? { state: "ready", lastSyncedAt: null, items: [{ repo: "owner/repo", number: 42, title: contract.option,
      state: "OPEN", updatedAt: "2026-09-23T11:00:00Z" }] }
    : { state: "ready", lastSyncedAt: null, issues: [] } } as any);
  const shape = { id: "shape:pointer-issue", kind: "github-issue", parentId: "page:p", index: "a1", x: 0, y: 0,
    rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { w: 260, h: 170, schemaVersion: 2 } };
  await act(async () => root.render(createElement(GithubIssueShape, { shape, dispatch } as any)));
  const input = host.querySelector<HTMLInputElement>('[role="combobox"]')!;
  await act(async () => input.focus());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
  const option = document.querySelector<HTMLButtonElement>('[role="option"]')!;
  expect(option.textContent).toContain(contract.option);
  await act(async () => option.click());
  expect(dispatch).toHaveBeenCalledWith([{ type: "UpdateProps", id: shape.id, props: { issueUrl: contract.issueUrl } }]);
  expect(JSON.stringify(dispatch.mock.calls)).not.toContain(contract.query);
  await act(async () => root.unmount());
});
