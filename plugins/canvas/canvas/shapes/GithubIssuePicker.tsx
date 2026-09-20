import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { ShapeBodyProps } from "@ensembleworks/canvas-react";
import { githubCache } from "../github-cache-client.js";
import { githubIssueUrl, parseGithubIssueUrl, type GithubPickerResponse } from "../github-issue.js";
import { resolveIssueLink } from "../panel/github-draft-model.js";

type Position = { top: number; left: number; width: number; maxHeight: number };

/** Local search and URL draft. Only a successfully linked URL enters the canvas document. */
export function GithubIssuePicker({ shape, dispatch, compact }: Pick<ShapeBodyProps, "shape" | "dispatch"> & { compact: boolean }) {
  const [query, setQuery] = useState(""), [open, setOpen] = useState(false);
  const [response, setResponse] = useState<GithubPickerResponse | null>(null);
  const [loading, setLoading] = useState(false), [active, setActive] = useState(-1);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const input = useRef<HTMLInputElement>(null), menu = useRef<HTMLDivElement>(null), generation = useRef(0);
  const linked = typeof shape.props.issueUrl === "string", linkedRef = useRef(linked); linkedRef.current = linked;
  const isUrl = parseGithubIssueUrl(query) !== null, items = response?.items ?? [];
  const showing = open && !isUrl;
  const listId = `github-issue-options-${shape.id}`;

  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => { if (linked) generation.current++; }, [linked]);
  useEffect(() => {
    if (!showing) return;
    let cancelled = false;
    setLoading(true); setResponse(null); setActive(-1);
    const timer = setTimeout(() => { void githubCache.searchIssues(query.trim()).then((result) => {
      if (!cancelled) { setResponse(result); setLoading(false); }
    }); }, query ? 180 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [showing, query]);
  useEffect(() => {
    if (!showing) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!input.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [showing]);
  useEffect(() => {
    if (!showing) { setPosition(null); return; }
    let frame = 0;
    const measure = () => {
      const rect = input.current?.getBoundingClientRect();
      if (rect) {
        const width = Math.min(Math.max(260, rect.width), Math.max(200, window.innerWidth - 16));
        const below = window.innerHeight - rect.bottom - 12, above = rect.top - 12;
        const placeAbove = below < 140 && above > below;
        const maxHeight = Math.max(80, Math.min(280, placeAbove ? above : below));
        const next = { top: placeAbove ? rect.top - maxHeight - 4 : rect.bottom + 4,
          left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), width, maxHeight };
        setPosition((prior) => prior && Object.keys(next).every((key) => prior[key as keyof Position] === next[key as keyof Position]) ? prior : next);
      }
      frame = requestAnimationFrame(measure);
    };
    frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [showing]);

  const link = async (url: string) => {
    if (busy || linked) return;
    setBusy(true); setError(null); setOpen(false);
    const current = ++generation.current;
    const result = await resolveIssueLink({ url, read: (repo) => githubCache.read(repo, true),
      isCurrent: () => current === generation.current && !linkedRef.current });
    if (result.state === "cancelled") return;
    if (result.state === "linked") {
      dispatch?.([{ type: "UpdateProps", id: shape.id, props: { issueUrl: githubIssueUrl(result.identity) } }]); return;
    }
    setError(result.state === "invalid_url" ? "Enter an https://github.com/owner/repo/issues/123 URL."
      : result.state === "untracked" ? "That repository is not tracked by this Canvas project."
      : "Cannot validate this repository right now. Try again later.");
    setBusy(false);
  };
  const choose = (index: number) => { const item = items[index]; if (item) void link(githubIssueUrl({ repo: item.repo, number: item.number })); };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (isUrl) void link(query);
    else choose(active >= 0 ? active : 0);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && showing) { event.preventDefault(); event.stopPropagation(); setOpen(false); return; }
    if (event.key === "Tab") { setOpen(false); return; }
    if (!showing || items.length === 0) return;
    if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); choose(active >= 0 ? active : 0); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); event.stopPropagation();
      setActive((previous) => event.key === "ArrowDown" ? Math.min(items.length - 1, previous + 1) : Math.max(0, previous - 1));
    }
  };
  const status = loading ? "Searching cached issues…"
    : response?.state === "plugin_unavailable" ? "GitHub plugin unavailable. Paste an issue URL instead."
    : response?.state === "needs_configuration" ? "GitHub authorization needed. Paste an issue URL instead."
    : response?.state === "cache_error" ? "Some cached issues could not be loaded."
    : response?.state === "unavailable" ? "GitHub cache unavailable. Paste an issue URL instead."
    : items.length === 0 ? "No cached issues found. You can paste an issue URL." : null;

  return <>
    <form data-canvas-interactive="" noValidate onSubmit={submit} onPointerDown={(event) => event.stopPropagation()}
      style={{ display: "flex", gap: 7, minWidth: 0 }}>
      <input ref={input} type="text" role="combobox" aria-label="Search issues or paste GitHub issue URL"
        aria-autocomplete="list" aria-expanded={showing} aria-controls={showing ? listId : undefined}
        aria-activedescendant={showing && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off" value={query} onChange={(event) => { setQuery(event.target.value); setError(null); setOpen(true); }}
        onFocus={() => setOpen(true)} onKeyDown={onKeyDown}
        placeholder={compact ? "Search issues or paste URL" : "Search issues or paste a GitHub issue URL"}
        style={{ minWidth: 0, flex: 1, padding: compact ? "7px 8px" : "10px 11px", border: "1px solid #b9c7d8", borderRadius: 7, color: "#20304a", fontSize: 12 }} />
      <button type="submit" disabled={busy || (!isUrl && items.length === 0)}
        style={{ padding: "0 11px", border: 0, borderRadius: 7, background: "#1759a5", color: "white", fontWeight: 700, cursor: "pointer" }}>
        {busy ? "Checking…" : "Link"}
      </button>
    </form>
    <p role={error ? "alert" : undefined} style={{ margin: "9px 0 0", color: error ? "#ab3247" : "#57606a", fontSize: 11, lineHeight: 1.35 }}>
      {error ?? "Choose a cached issue, or paste a URL for an older issue."}
    </p>
    {showing && position && typeof document !== "undefined" && createPortal(
      <div ref={menu} id={listId} role="listbox" aria-label="Cached GitHub issues" data-canvas-interactive=""
        style={{ position: "fixed", zIndex: 2147483000, top: position.top, left: position.left, width: position.width,
          maxHeight: position.maxHeight, overflowY: "auto", boxSizing: "border-box", background: "white",
          border: "1px solid #b9c7d8", borderRadius: 7, boxShadow: "0 12px 30px #283b5c33",
          fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif" }}>
        {items.map((item, index) => <button key={`${item.repo}#${item.number}`} id={`${listId}-${index}`} role="option"
          aria-selected={active === index} type="button" onPointerDown={(event) => event.preventDefault()}
          onMouseEnter={() => setActive(index)} onClick={() => choose(index)}
          style={{ display: "block", width: "100%", padding: "8px 11px", border: 0, textAlign: "left",
            background: active === index ? "#ddf4ff" : "white", color: "#1f2328", cursor: "pointer" }}>
          <span style={{ display: "block", fontSize: 12, fontWeight: 650, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</span>
          <span style={{ display: "block", fontSize: 10, color: "#57606a" }}>{item.repo} #{item.number} · {item.state.toLowerCase()}</span>
        </button>)}
        {status && <div role="status" style={{ padding: "9px 11px", color: "#57606a", fontSize: 11 }}>{status}</div>}
      </div>, document.body)}
  </>;
}
