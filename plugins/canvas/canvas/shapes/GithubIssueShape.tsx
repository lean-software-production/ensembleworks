import { memo, type CSSProperties } from "react";
import type { ShapeBodyProps } from "@ensembleworks/canvas-react";
import { githubIssueUrl, parseGithubIssueUrl } from "../github-issue.js";
import { useGithubRepo, type RepoSnapshot } from "../github-cache-client.js";
import { GithubIssuePicker } from "./GithubIssuePicker.js";

const ink = "#1f2328", muted = "#57606a", hairline = "#d0d7de";

function timeLabel(raw: string | null): string {
  if (!raw) return "Not yet synced";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function GithubIssueCard({ shape, repoSnapshot }: Pick<ShapeBodyProps, "shape"> & { repoSnapshot: RepoSnapshot }) {
  const identity = shape.props.schemaVersion === 2 && typeof shape.props.issueUrl === "string"
    ? parseGithubIssueUrl(shape.props.issueUrl)
    : shape.props.schemaVersion === 1 && typeof shape.props.repo === "string" && typeof shape.props.number === "number"
      ? parseGithubIssueUrl(`https://github.com/${shape.props.repo}/issues/${shape.props.number}`) : null;
  const repo = identity?.repo ?? "";
  const snapshot = repoSnapshot; const current = snapshot.current;
  const activeIssue = current?.state === "ready" && identity ? current.issues.find((issue) => issue.number === identity.number) ?? null : null;
  const oldIssue = current && current.state !== "ready" && current.state !== "untracked" && identity && snapshot.lastGood ? snapshot.lastGood.issues.find((issue) => issue.number === identity.number) ?? null : null;
  const issue = activeIssue || oldIssue;
  const w = Number(shape.props.w) || 470; const h = Number(shape.props.h) || 256;
  const compact = w < 360 || h < 300; const tight = h < 240;
  const status = !identity ? "Invalid issue identity"
    : !current ? "Loading GitHub cache…"
    : current.state === "untracked" ? "Repository is no longer tracked by this Canvas project"
    : current.state === "needs_configuration" ? "GitHub authorization needed"
    : current.state === "plugin_unavailable" ? "GitHub plugin unavailable"
    : current.state === "cache_error" ? "GitHub cache read failed"
    : current.state === "unavailable" ? "GitHub cache unavailable"
    : !activeIssue ? "Not in GitHub cache" : null;
  const url = identity ? githubIssueUrl(identity) : null;
  const header: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
    minHeight: compact ? 37 : 48, padding: compact ? "7px 11px" : "10px 16px", background: "#f6f8fa", borderBottom: `1px solid ${hairline}` };
  return (
    <article data-shape-body="github-issue" aria-label={identity ? `GitHub issue ${identity.repo} number ${identity.number}` : "Invalid GitHub issue card"}
      style={{ width: "100%", height: "100%", boxSizing: "border-box", display: "flex", flexDirection: "column", overflow: "hidden",
        border: `1px solid ${hairline}`, borderRadius: 7, background: "#fff", color: ink,
        fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif",
        boxShadow: "0 8px 27px #283b5c1b, 0 1px 3px #22385612" }}>
      <header style={header}>
        <div style={{ display: "flex", alignItems: "center", minWidth: 0, gap: 7 }}>
          <svg width={compact ? 15 : 18} height={compact ? 15 : 18} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ flexShrink: 0 }}><path d="M12 .5C5.73.5.5 5.73.5 12c0 5.02 3.18 9.27 7.59 10.78.56.1.77-.24.77-.54 0-.27-.01-1.16-.02-2.11-3.09.67-3.74-1.31-3.74-1.31-.5-1.28-1.23-1.62-1.23-1.62-1.01-.69.08-.68.08-.68 1.12.08 1.71 1.15 1.71 1.15.99 1.7 2.6 1.21 3.24.93.1-.72.39-1.21.7-1.49-2.47-.28-5.06-1.24-5.06-5.5 0-1.21.43-2.2 1.14-2.98-.12-.28-.5-1.41.11-2.95 0 0 .93-.3 3.05 1.14A10.5 10.5 0 0 1 12 6.32c.95 0 1.91.13 2.81.38 2.12-1.44 3.05-1.14 3.05-1.14.6 1.54.23 2.67.11 2.95.71.78 1.14 1.77 1.14 2.98 0 4.27-2.59 5.22-5.07 5.5.4.34.75 1.02.75 2.06 0 1.49-.01 2.69-.01 3.05 0 .3.2.65.77.54A11.51 11.51 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z"/></svg>
          <span style={{ color: "#0969da", fontSize: compact ? 11 : 12, fontWeight: 650, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{repo || "GitHub issue"}</span>
        </div>
        {url && <a data-canvas-interactive="" href={url} target="_blank" rel="noopener noreferrer"
          aria-label={`Open issue ${identity!.number} on GitHub in a new tab`}
          onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
          style={{ color: "#48515a", fontSize: compact ? 11 : 12, fontWeight: 700, flexShrink: 0, borderRadius: 3, textDecoration: "underline" }}>
          #{identity!.number} ↗
        </a>}
      </header>
      <div style={{ display: "flex", flex: 1, minHeight: 0, flexDirection: "column", padding: tight ? "6px 11px" : compact ? "10px 11px" : "16px 16px 12px", overflow: "hidden" }}>
        {issue ? <>
          <h2 title={issue.title} style={{ margin: 0, fontSize: compact ? 14 : 20, lineHeight: tight ? 1.2 : 1.25, letterSpacing: "-.02em", fontWeight: 650,
            flexShrink: 0, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: compact ? 2 : 3, WebkitBoxOrient: "vertical" }}>{issue.title}</h2>
          {status && <div role="status" style={{ marginTop: tight ? 4 : 8, padding: compact ? 0 : "5px 7px", border: compact ? 0 : "1px solid #f3d5d8", borderRadius: 5, color: "#9d3147", background: compact ? "transparent" : "#fff5f5", fontSize: 10, lineHeight: 1.2, whiteSpace: tight ? "nowrap" : undefined, overflow: tight ? "hidden" : undefined, textOverflow: tight ? "ellipsis" : undefined, flexShrink: 0 }}>{status} · details may be stale</div>}
          {(!status || h >= 190) && <div style={{ display: "flex", gap: tight ? 5 : 8, alignItems: "center", marginTop: tight ? 5 : compact ? 8 : 12, flexWrap: tight ? "nowrap" : "wrap", overflow: tight ? "hidden" : undefined, flexShrink: 0 }}>
            <span style={{ borderRadius: 999, padding: tight ? "2px 7px" : "4px 9px", background: issue.state.toUpperCase() === "OPEN" ? "#1a7f37" : "#8250df", color: "#fff", fontSize: tight ? 10 : 11, lineHeight: 1.2, fontWeight: 700, flexShrink: 0 }}>
              {issue.state.toUpperCase() === "OPEN" ? "◉ Open" : "● Closed"}
            </span>
            <span style={{ color: muted, fontSize: compact ? 10 : 11, minWidth: 0, overflow: tight ? "hidden" : undefined, textOverflow: tight ? "ellipsis" : undefined, whiteSpace: tight ? "nowrap" : undefined }}>{compact ? "by " : "Opened by "}<strong>@{issue.author || "unknown"}</strong></span>
            {tight && issue.assignees.length > 0 && <span title={`Assignees: ${issue.assignees.join(", ")}`} style={{ color: muted, fontSize: 10, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>to <strong>@{issue.assignees[0]}</strong></span>}
          </div>}
          {issue.bodyPreview && <div data-github-issue-body="" style={{ flex: "1 1 0%", minHeight: 0, overflow: "hidden",
            color: muted, fontSize: compact ? 11 : 12, lineHeight: "16px", overflowWrap: "anywhere" }}>
            <p style={{ margin: "8px 0 0" }}>{issue.bodyPreview}</p>
          </div>}
          {!tight && h >= 250 && <div style={{ display: "flex", gap: 5, alignItems: "center", marginTop: "auto", paddingTop: 8, minWidth: 0, overflow: "hidden", flexShrink: 0 }}>
            {issue.labels.slice(0, compact ? 2 : 3).map((label) => <span key={label} title={label} style={{ display: "inline-block", maxWidth: compact ? 72 : 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", border: "1px solid #b6e3ff", borderRadius: 999, padding: "3px 7px", background: "#ddf4ff", color: "#0969da", fontSize: 10, fontWeight: 650 }}>{label}</span>)}
            {issue.labels.length > (compact ? 2 : 3) && <span style={{ fontSize: 10, color: muted }}>+{issue.labels.length - (compact ? 2 : 3)}</span>}
            {issue.assignees.length > 0 && <span style={{ marginLeft: "auto", color: muted, fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={`Assignees: ${issue.assignees.join(", ")}`}>
              {!compact && "Assignee "}<strong>@{issue.assignees[0]}</strong>{issue.assignees.length > 1 && ` +${issue.assignees.length - 1}`}
            </span>}
          </div>}
        </> : <div style={{ margin: "auto 0", color: muted, fontSize: compact ? 12 : 14 }}>{status ?? "Not in GitHub cache"}</div>}
      </div>
      <footer style={{ display: compact ? "grid" : "flex", gap: compact ? 2 : 8, justifyContent: compact ? undefined : "space-between", padding: compact ? "5px 11px" : "9px 16px", borderTop: `1px solid ${hairline}`, color: muted, fontSize: compact ? 10 : 11, lineHeight: 1.25, whiteSpace: compact ? "normal" : "nowrap", overflowWrap: "anywhere", flexShrink: 0 }}>
        <span>Issue updated {issue ? timeLabel(issue.updatedAt) : "unknown"}</span>
        <span title="Latest GitHub plugin sync across tracked repositories. This issue may have older data." aria-label={`GitHub sync ${timeLabel(current?.lastSyncedAt ?? snapshot.lastGood?.lastSyncedAt ?? null)}. This is the latest global GitHub plugin sync; this issue may have older data.`}>
          GitHub sync {timeLabel(current?.lastSyncedAt ?? snapshot.lastGood?.lastSyncedAt ?? null)}
        </span>
      </footer>
    </article>
  );
}

function UnlinkedIssueCard({ shape, dispatch }: ShapeBodyProps) {
  const compact = Number(shape.props.w) < 360 || Number(shape.props.h) < 220;
  return <article data-shape-body="github-issue" data-github-issue-unlinked="" aria-label="Unlinked GitHub issue card"
    style={{ width: "100%", height: "100%", boxSizing: "border-box", display: "flex", flexDirection: "column", overflow: "hidden",
      border: `1px solid ${hairline}`, borderRadius: 7, background: "#fff", color: ink,
      fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif", boxShadow: "0 8px 27px #283b5c1b, 0 1px 3px #22385612" }}>
    <header style={{ padding: compact ? "8px 11px" : "11px 16px", borderBottom: `1px solid ${hairline}`, background: "#f6f8fa", color: "#0969da", fontWeight: 650, fontSize: 12 }}>◉ GitHub issue</header>
    <div style={{ display: "flex", flex: 1, minHeight: 0, flexDirection: "column", padding: compact ? "10px 11px" : "15px 16px" }}>
      {!compact && <div style={{ color: muted, fontSize: 11, fontWeight: 750, letterSpacing: ".08em", textTransform: "uppercase" }}>New card</div>}
      <GithubIssuePicker shape={shape} dispatch={dispatch} compact={compact} />
    </div>
  </article>;
}

function LinkedIssueShape({ shape }: ShapeBodyProps) {
  const repo = shape.props.schemaVersion === 2 ? parseGithubIssueUrl(String(shape.props.issueUrl))?.repo : shape.props.repo;
  return <GithubIssueCard shape={shape} repoSnapshot={useGithubRepo(String(repo ?? ""))} />;
}

function GithubIssueShapeInner(props: ShapeBodyProps) {
  return props.shape.props.schemaVersion === 2 && props.shape.props.issueUrl === undefined
    ? <UnlinkedIssueCard {...props} /> : <LinkedIssueShape {...props} />;
}

export const GithubIssueShape = memo(GithubIssueShapeInner, (a, b) => a.shape === b.shape);
