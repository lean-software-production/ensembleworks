/**
 * `ui/graph-section.tsx` — the side panel's Graph accordion (run-panel
 * redesign, "1 · Map"): the dagre graph in theme colours, following the
 * current stage until the user pans or zooms, a Follow control to pick it
 * back up, an "Open large" overlay for authoring and debugging, and a short
 * detail card for the selected node — where each of its outcomes routes,
 * and its earlier visits.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { GraphView, RunView, StageView } from "../server/contracts";
import { DagView } from "./dag";
import { formatDuration, formatShortDuration, inFlight, nodeLabel, routesFrom, type EventView } from "./run-model";
import { providerLabel } from "./stages";
import { Btn, MUTED, ROW, SMALL, TOKENS } from "./primitives";

export interface GraphSectionProps {
  run: RunView;
  stages: StageView[];
  graph: GraphView;
  events: EventView[];
  now: number;
  onOpenThread(threadId: string): void;
}

/** The node the view follows and selects by default: the first stage in flight, else the run's checkpointed node. */
export function focusNodeId(run: RunView, stages: readonly StageView[]): string | null {
  return inFlight(stages)[0]?.nodeId ?? run.currentNodeId ?? null;
}

const STATUS_WORD: Record<StageView["status"], string> = {
  running: "running",
  blocked: "waiting",
  succeeded: "succeeded",
  failed: "failed",
  skipped: "skipped",
  cancelled: "stopped",
};

function NodeDetail({ graph, stages, nodeId, now, onOpenThread }: { graph: GraphView; stages: StageView[]; nodeId: string; now: number; onOpenThread(threadId: string): void }) {
  const node = graph.nodes.find((n) => n.id === nodeId);
  const visits = stages.filter((s) => s.nodeId === nodeId);
  const latest = visits.at(-1) ?? null;
  const earlier = visits.slice(0, -1).filter((s) => s.completedAt !== null);
  const average = earlier.length ? earlier.reduce((sum, s) => sum + (s.completedAt! - s.startedAt), 0) / earlier.length : 0;
  const routes = routesFrom(graph, nodeId);
  const provider = latest ? providerLabel(latest, node) : node?.provider || node?.model ? [node.provider, node.model].filter(Boolean).join(" / ") : "—";
  const statusTone = latest?.status === "failed" ? TOKENS.destructiveText : latest?.status === "blocked" ? TOKENS.warningText : latest?.status === "running" ? TOKENS.brand : TOKENS.mutedFg;
  return (
    <div data-testid="node-detail" style={{ background: TOKENS.recessed, borderRadius: `calc(${TOKENS.radius} - 2px)`, padding: "8px 10px", marginTop: 8, fontSize: 12 }}>
      <div style={ROW}>
        <strong>{node?.label ?? nodeId}</strong>
        <span style={MUTED}>selected</span>
        <span style={{ flex: 1 }} />
        {latest ? (
          <span style={{ color: statusTone }}>
            {STATUS_WORD[latest.status]} {formatShortDuration(Math.max(0, (latest.completedAt ?? now) - latest.startedAt))}
          </span>
        ) : (
          <span style={MUTED}>not reached</span>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: "3px 8px", marginTop: 5 }}>
        <span style={MUTED}>Goes to</span>
        <span data-testid="node-routes">
          {routes.length === 0
            ? "Nowhere: the run ends here"
            : routes.map((r, i) => (
                <span key={`${r.to}-${i}`}>
                  {i > 0 ? " · " : ""}
                  <strong>{r.toLabel}</strong> {r.when}
                </span>
              ))}
        </span>
        <span style={MUTED}>Earlier</span>
        <span data-testid="node-earlier">
          {earlier.length === 0 ? "No earlier visits" : `${earlier.length} ${earlier.length === 1 ? "visit" : "visits"}, average ${formatDuration(average)}`}
        </span>
        {provider !== "—" ? (
          <>
            <span style={MUTED}>Model</span>
            <span>{provider}</span>
          </>
        ) : null}
      </div>
      {latest?.threadId ? (
        <div style={{ ...ROW, marginTop: 7 }}>
          <Btn variant="ghost" onClick={() => onOpenThread(latest.threadId!)}>
            Open worker
          </Btn>
        </div>
      ) : null}
    </div>
  );
}

function LargeGraph({ title, onClose, children }: { title: string; onClose(): void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Fixed over the whole window, so it is not clipped by the side panel.
  // The overlay owns its own scrolling (it is outside every host scroller).
  return createPortal(
    <div
      data-testid="graph-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`${title}: workflow graph`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0, 0, 0, 0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
    >
      <div
        className="bg-card text-card-foreground"
        style={{ background: TOKENS.card, color: TOKENS.cardFg, border: `1px solid ${TOKENS.border}`, borderRadius: TOKENS.radius, width: "min(1100px, 100%)", maxHeight: "100%", overflow: "auto", padding: 16 }}
      >
        <div style={{ ...ROW, marginBottom: 8 }}>
          <strong>{title}</strong>
          <span style={{ flex: 1 }} />
          <Btn variant="ghost" onClick={onClose} aria-label="Close large graph">
            Close
          </Btn>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function GraphSection({ run, stages, graph, events, now, onOpenThread }: GraphSectionProps) {
  const focus = focusNodeId(run, stages);
  const [following, setFollowing] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [large, setLarge] = useState(false);
  const selectedNodeId = selected ?? focus;
  const live = run.status === "running" || run.status === "blocked";

  const dag = (big: boolean) => (
    <DagView
      graph={graph}
      events={events}
      currentNodeId={focus}
      selectedNodeId={selectedNodeId}
      onSelectNode={setSelected}
      followNodeId={big ? undefined : focus}
      following={big ? false : following}
      onFollowingChange={setFollowing}
      maxHeight={big ? Math.max(320, (typeof window !== "undefined" ? window.innerHeight : 800) - 260) : 360}
    />
  );

  return (
    <div data-testid="graph-section">
      <div style={{ background: TOKENS.recessed, borderRadius: `calc(${TOKENS.radius} - 2px)`, padding: 6 }}>{dag(false)}</div>
      <div style={{ ...ROW, ...SMALL, marginTop: 6 }}>
        <span style={MUTED}>{following ? (live ? "Follows the current stage" : "Centred on where the run ended") : "Moved by you"}</span>
        <span style={{ flex: 1 }} />
        {!following ? (
          <Btn variant="ghost" onClick={() => setFollowing(true)}>
            Follow
          </Btn>
        ) : null}
        <Btn variant="ghost" onClick={() => setLarge(true)}>
          Open large ⤢
        </Btn>
      </div>
      {selectedNodeId ? <NodeDetail graph={graph} stages={stages} nodeId={selectedNodeId} now={now} onOpenThread={onOpenThread} /> : null}
      {large ? (
        <LargeGraph title={run.title ?? "Attractor run"} onClose={() => setLarge(false)}>
          <div style={{ background: TOKENS.recessed, borderRadius: `calc(${TOKENS.radius} - 2px)`, padding: 8 }}>{dag(true)}</div>
          {selectedNodeId ? <NodeDetail graph={graph} stages={stages} nodeId={selectedNodeId} now={now} onOpenThread={onOpenThread} /> : null}
          <div style={{ ...SMALL, ...MUTED, marginTop: 6 }}>Select a node to read its routes. Ctrl/⌘ + scroll zooms; drag to pan. Esc closes. {selectedNodeId ? `Selected: ${nodeLabel(graph, selectedNodeId)}.` : ""}</div>
        </LargeGraph>
      ) : null}
    </div>
  );
}
