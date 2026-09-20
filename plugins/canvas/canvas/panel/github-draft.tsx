import { useCallback, useEffect, useRef, useState, type FormEvent, type PointerEvent, type RefObject } from "react";
import { type CanvasDocument } from "@ensembleworks/canvas-model";
import { screenToWorld, type Editor } from "@ensembleworks/canvas-editor";
import type { CanvasSession } from "@ensembleworks/canvas-ui";
import { githubCache } from "../github-cache-client.js";
import { resolveIssueDraft } from "./github-draft-model.js";

interface DraftPoint { readonly x: number; readonly y: number; readonly screenX: number; readonly screenY: number }

export function useGithubIssueDraft(editor: Editor, canvas: CanvasSession, snapshot: CanvasDocument, viewportRef: RefObject<HTMLDivElement | null>) {
  const [placing, setPlacing] = useState(false); const [draft, setDraft] = useState<DraftPoint | null>(null);
  const [url, setUrl] = useState(""); const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const inputRef = useRef<HTMLInputElement | null>(null);
  const generation = useRef(0);

  const cancel = useCallback(() => {
    generation.current++;
    setPlacing(false); setDraft(null); setUrl(""); setError(null); setBusy(false);
  }, []);
  const arm = useCallback(() => {
    if (placing || draft) { cancel(); return; }
    canvas.selectTool("select");
    setPlacing(true);
  }, [canvas, placing, draft, cancel]);
  const place = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!placing || draft || (event.target as Element).closest("[data-canvas-interactive]")) return;
    const viewport = viewportRef.current; if (!viewport) return;
    event.preventDefault(); event.stopPropagation();
    const bounds = viewport.getBoundingClientRect();
    const screenX = event.clientX - bounds.left; const screenY = event.clientY - bounds.top;
    const world = screenToWorld(editor.get().camera, { x: screenX, y: screenY });
    setDraft({ ...world, screenX, screenY }); setPlacing(false);
  }, [placing, draft, viewportRef, editor]);
  const openAtCenter = useCallback(() => { if (!placing || draft) return;
    const viewport = viewportRef.current; if (!viewport) return;
    const screenX = viewport.clientWidth / 2; const screenY = viewport.clientHeight / 2; setDraft({ ...screenToWorld(editor.get().camera, { x: screenX, y: screenY }), screenX, screenY }); setPlacing(false);
  }, [placing, draft, viewportRef, editor]);
  useEffect(() => { if (draft) inputRef.current?.focus(); }, [draft]);
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => {
    if (!placing && !draft) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [placing, draft, cancel]);

  const submit = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || busy) return;
    setBusy(true); setError(null);
    const token = ++generation.current;
    const pageId = editor.get().currentPageId; const siblings = snapshot.shapes.filter((shape) => shape.parentId === pageId);
    const result = await resolveIssueDraft({ url, point: draft, pageId, siblings,
      read: (repo) => githubCache.read(repo, true), isCurrent: () => token === generation.current,
      newId: () => `shape:${crypto.randomUUID()}` });
    if (result.state === "cancelled") return;
    if (result.state === "invalid_url") { setError("Enter an https://github.com/owner/repo/issues/123 URL."); setBusy(false); return; }
    if (result.state === "untracked") { setError("That repository is not tracked by this Canvas project."); setBusy(false); return; }
    if (result.state === "unavailable") { setError("Cannot validate this repository right now. Try again later."); setBusy(false); return; }
    if (result.state !== "created") return;
    canvas.dispatch([{ type: "CreateShape", shape: result.shape }, { type: "SetSelection", ids: [result.shape.id] }]);
    canvas.selectTool("select"); cancel();
  }, [draft, busy, url, editor, snapshot, canvas, cancel]);

  const viewport = viewportRef.current;
  const width = viewport?.clientWidth || 1024; const height = viewport?.clientHeight || 768;
  const draftWidth = Math.min(470, Math.max(260, width - 16));
  const left = draft ? Math.max(8, Math.min(draft.screenX - draftWidth / 2, width - draftWidth - 8)) : 8; const top = draft ? Math.max(8, Math.min(draft.screenY - 128, height - 250)) : 8;
  const draftUi = draft ? (
    <section data-canvas-interactive="" data-canvas-github-draft="" aria-label="Add GitHub issue card"
      style={{ position: "absolute", zIndex: 20, left, top, width: draftWidth, minHeight: 218, boxSizing: "border-box", overflow: "hidden", border: "1px solid #d0d7de", borderRadius: 7, background: "white", boxShadow: "0 12px 35px #283b5c44", color: "#1f2328", fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif" }}>
      <header style={{ padding: "11px 16px", borderBottom: "1px solid #d0d7de", background: "#f6f8fa", color: "#0969da", fontWeight: 650, fontSize: 12 }}>◉ GitHub issue</header>
      <div style={{ padding: "14px 16px" }}>
        <div style={{ color: "#57606a", fontSize: 11, fontWeight: 750, letterSpacing: ".08em", textTransform: "uppercase" }}>New card</div>
        <h2 style={{ margin: "5px 0 13px", fontSize: 18 }}>Paste an issue URL</h2>
        <form noValidate onSubmit={submit} style={{ display: "flex", gap: 7 }}>
          <input ref={inputRef} type="url" aria-label="GitHub issue URL" value={url} onChange={(event) => { setUrl(event.target.value); setError(null); }}
            placeholder="https://github.com/owner/repo/issues/123" style={{ minWidth: 0, flex: 1, padding: "10px 11px", border: "1px solid #b9c7d8", borderRadius: 7, color: "#20304a", fontSize: 12 }} />
          <button type="submit" disabled={busy} style={{ padding: "0 13px", border: 0, borderRadius: 7, background: "#1759a5", color: "white", fontWeight: 700, cursor: "pointer" }}>{busy ? "Checking…" : "Add"}</button>
        </form>
        <p role={error ? "alert" : undefined} style={{ margin: "11px 0 0", color: error ? "#ab3247" : "#57606a", fontSize: 11, lineHeight: 1.4 }}>
          {error ?? "Only repositories tracked by this BB project can be added. Press Esc to cancel."}
        </p>
        <button type="button" onClick={cancel} style={{ marginTop: 9, padding: 0, border: 0, background: "transparent", color: "#0969da", fontSize: 11, cursor: "pointer" }}>Cancel</button>
      </div>
    </section>
  ) : null;
  return { placing, draftUi, arm, place, openAtCenter, cancel };
}
