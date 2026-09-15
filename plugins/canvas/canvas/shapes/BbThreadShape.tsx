// The `bbthread` shape's body — "hands only": every decision it renders
// comes from bbthread-model.ts (pane state, layout, pane interaction, the
// spawn prompt); this file only wires those decisions to real DOM elements
// and the host SDK's `ThreadChat`/`experimental_useSidebarThreads`/`useRpc`
// hooks. See docs/plans/2026-09-15-bb-thread-frame.md and this plugin's
// README's "The bb thread frame" section.
//
// INTERACTION POLICY (2026-09-15, "Pane input routing" follow-up): the
// EDITOR decides whether the pane is interactive, not this body. Double-
// clicking the pane, Escape, and clicking outside are all handled by
// canvas-editor's select-tool FSM now (`BeginEdit { region: 'body' }` /
// `EndEdit`); this component only READS `editorState.editingId`/
// `editingRegion` (via `paneInteraction`) and reflects the answer: it sets
// `data-canvas-interactive` on the pane ONLY while interactive — the
// attribute canvas-react's viewport yield rule looks for to stop capturing/
// forwarding pointer, wheel and (non-Escape) key events aimed inside it —
// and shows a small hint bar (double-click to focus / Esc to leave / etc)
// while it is not. There is no local idle/focused reducer here any more;
// see bbthread-model.ts's PANE INTERACTION section.
//
// COMPOSER WHILE FOCUSED (2026-09-15, owner-approved trial): the pane is
// read-only (`ThreadChat variant="timeline"`) while idle, and gains the host
// composer (`variant="compact"`) the moment it becomes interactive — a
// `focusRequest` counter (bumped on every idle→interactive transition) rides
// along so a double-click lands the user directly in the composer rather
// than just the transcript. Two known trade-offs, under live trial: (1) the
// variant switch REMOUNTS `ThreadChat` (it is a different `variant`, not a
// prop update), so the timeline's scroll position resets on both focus and
// blur; (2) Escape is always forwarded straight through by the viewport
// (canvas-react's yield rule never withholds it) and ends the pane's editing
// state, so a host popover inside the composer that also listens for Escape
// (an emoji picker, say) may drop the user out of the pane instead of just
// closing itself.
//
// NOT AN EMBED (canvas-react's `registerShape` `{ embed: true }` flag):
// `ThreadChat` keeps its own connection to the thread and re-fetches on
// mount, exactly like RoadmapShape.tsx's own "not an embed" note — a
// cull-unmount just means the next mount re-subscribes.
//
// MEMO STRATEGY (shapeRegistry.ts's ShapeBodyProps doc comment): wrapped in
// `React.memo` with a CONTENT comparator on `shape`
// (`stableStringify`, canvas-model's canonical serialization) PLUS
// `editorState.editingId`/`editingRegion` — the two editor-state fields
// `paneInteraction` reads, so a change in either (this pane becoming/
// ceasing to be the one being edited) still re-renders even though `shape`
// itself didn't change. `snapshot` changes identity every doc commit
// regardless of whether this shape's own children changed, and diffing
// against it would defeat the whole point of memoizing a body this heavy (a
// live `ThreadChat` mount) — so it stays OUT of the comparator. CONSEQUENCE,
// STATED PLAINLY: `snapshot`/`getText` are read ONLY inside the "New thread
// from these elements" codepath (computed where used, never hoisted into a
// `useMemo` keyed on `snapshot` — that would still only run when this
// component actually re-renders, so it buys nothing but a false sense of
// reactivity) — so the composed prompt reflects the workspace's children as
// of this body's LAST GENUINE re-render (a `shape`-content change: `name`,
// `threadId`, position, etc.), not necessarily the absolute latest doc
// state if children were added/removed with no change to the frame's own
// props in between. Accepted for this pilot (docs/plans/2026-09-15-bb-
// thread-frame.md) — the comparator's win is worth more than perfect
// spawn-prompt freshness, and the common case (add children, then click
// "New thread") re-renders anyway via the pointer/selection activity that
// usually surrounds it.
import { memo, useEffect, useState, type CSSProperties } from "react";
import { childrenOf, stableStringify, type Shape } from "@ensembleworks/canvas-model";
import type { ShapeBodyProps } from "@ensembleworks/canvas-react";
import { ThreadChat, experimental_useSidebarThreads, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../rpc-contract.js";
import { filterThreadOptions, type ThreadOption } from "../thread-picker.js";
import { openBbThread } from "./bbthread-host.js";
import {
  bbthreadPaneState,
  paneInteraction,
  paneLayout,
  spawnPromptFor,
  threadIdOf,
  type PaneState,
  type PaneTone,
} from "./bbthread-model.js";

const DEFAULT_LABEL = "Thread frame";

/** `shape.props.name`, defaulted to "Thread frame" — canvas-react's
 * FrameShape.tsx's own `frameLabel` rule (that file is not on canvas-react's
 * public barrel, so it is restated here rather than imported), plus a
 * " · Thread frame" suffix when a name IS set, so a bbthread's header always
 * says what kind of frame it is (matches the plan's mockup: "YAK MAP ·
 * THREAD FRAME"). */
function bbthreadLabel(shape: Shape): string {
  const raw = (shape.props as Record<string, unknown>).name;
  const name = typeof raw === "string" ? raw.trim() : "";
  return name.length > 0 ? `${name} · ${DEFAULT_LABEL}` : DEFAULT_LABEL;
}

const TONE_COLOR: Record<PaneTone, string> = {
  working: "#0a7f3f",
  idle: "var(--muted-foreground)",
  attention: "#b45309",
  failed: "#b91c1c",
};

function boundsStyle(b: { minX: number; minY: number; maxX: number; maxY: number }): CSSProperties {
  return { position: "absolute", left: b.minX, top: b.minY, width: Math.max(0, b.maxX - b.minX), height: Math.max(0, b.maxY - b.minY) };
}

function TonePill({ tone, label }: { readonly tone: PaneTone; readonly label: string }) {
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 0.4,
        textTransform: "uppercase",
        color: TONE_COLOR[tone],
        border: `1px solid ${TONE_COLOR[tone]}`,
        borderRadius: 3,
        padding: "1px 6px",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

interface PickerProps {
  readonly options: readonly ThreadOption[] | null;
  readonly error: string | null;
  readonly query: string;
  readonly onQuery: (q: string) => void;
  readonly onPick: (threadId: string) => void;
  readonly spawnDisabled: boolean;
  readonly busy: boolean;
  readonly onSpawn: () => void;
}

/** The unbound pane's content: a filter box + row list, and the spawn
 * button. A row's own click binds directly (`onPick`); nothing here decides
 * WHICH threads are offered or in what order — that's
 * `canvas_thread_options`'s job server-side, filtered client-side by
 * `filterThreadOptions` (thread-picker.ts), the same pure rule the retired
 * launch-or-attach picker used. */
function UnboundPicker({ options, error, query, onQuery, onPick, spawnDisabled, busy, onSpawn }: PickerProps) {
  const rows = options === null ? [] : filterThreadOptions(options, query);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 8, minHeight: 0, flex: 1 }}>
      <input
        data-canvas-bbthread="picker"
        placeholder="Find a thread…"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        style={{ font: "inherit", fontSize: 12, padding: "4px 6px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--background)", color: "var(--foreground)" }}
      />
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
        {error !== null && <div style={{ fontSize: 11, color: TONE_COLOR.failed }}>{error}</div>}
        {options === null && error === null && <div style={{ fontSize: 11, color: "var(--muted-foreground)" }}>Loading threads…</div>}
        {options !== null && rows.length === 0 && <div style={{ fontSize: 11, color: "var(--muted-foreground)" }}>No threads in this project yet.</div>}
        {rows.map((option) => (
          <button
            key={option.threadId}
            data-canvas-bbthread="picker"
            onClick={() => onPick(option.threadId)}
            style={{ textAlign: "left", font: "inherit", fontSize: 12, padding: "4px 6px", border: "none", borderRadius: 4, background: "transparent", cursor: "pointer", color: "var(--foreground)" }}
          >
            {option.label}
          </button>
        ))}
      </div>
      <button
        data-canvas-bbthread="spawn"
        disabled={spawnDisabled || busy}
        onClick={onSpawn}
        style={{
          font: "inherit",
          fontSize: 12,
          padding: "6px 8px",
          border: "1px solid var(--border)",
          borderRadius: 4,
          background: spawnDisabled || busy ? "var(--muted)" : "var(--primary)",
          color: spawnDisabled || busy ? "var(--muted-foreground)" : "var(--primary-foreground)",
          cursor: spawnDisabled || busy ? "default" : "pointer",
        }}
      >
        {busy ? "Spawning…" : "New thread from these elements"}
      </button>
    </div>
  );
}

function BbThreadShapeInner({ shape, snapshot, editorState, getText, dispatch }: ShapeBodyProps) {
  const rpc = useRpc<typeof rpcContract>();
  const sidebar = experimental_useSidebarThreads();
  const threadId = threadIdOf(shape);
  const thread = threadId === null ? undefined : sidebar.threads.find((t) => t.id === threadId);
  const pane: PaneState = bbthreadPaneState(shape, thread, sidebar.status);
  const layout = paneLayout(shape);
  const interaction = paneInteraction(shape, pane, { editingId: editorState.editingId, editingRegion: editorState.editingRegion });
  // A present-but-empty `data-canvas-interactive` attribute means
  // interactive (canvas-react's viewport yield rule keys off PRESENCE, not
  // value) — so this must be an absent key, not a `false`-valued one, when
  // not interactive. Named so the conditional itself (not just its use) is
  // independently assertable — see tests/bbthread-wiring.test.ts.
  const interactiveAttrs = interaction.interactive ? { "data-canvas-interactive": "" } : {};
  // "compact" carries the host composer, "timeline" is read-only-transcript
  // — see the module header's COMPOSER WHILE FOCUSED note.
  const chatVariant = interaction.interactive ? "compact" : "timeline";

  // Bumped once on every idle→interactive transition (never on a mount that
  // starts non-interactive, and never on the interactive→idle transition
  // back out) so a double-click into the pane also focuses the composer.
  const [focusRequest, setFocusRequest] = useState(0);
  useEffect(() => {
    if (interaction.interactive) setFocusRequest((n) => n + 1);
  }, [interaction.interactive]);

  const [options, setOptions] = useState<ThreadOption[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);

  useEffect(() => {
    if (pane.kind !== "unbound") return;
    let cancelled = false;
    rpc
      .call("canvas_thread_options", null)
      .then((result) => {
        if (!cancelled) setOptions(result.options);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setPickerError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [pane.kind, rpc, shape.id]);

  const bind = (nextThreadId: string) => dispatch?.([{ type: "UpdateProps", id: shape.id, props: { threadId: nextThreadId } }]);
  const unbind = () => dispatch?.([{ type: "UpdateProps", id: shape.id, props: { threadId: "" } }]);

  const spawnPrompt = pane.kind === "unbound" ? spawnPromptFor(childrenOf(snapshot, shape.id), (id) => getText?.(id) ?? "") : null;
  const spawn = () => {
    if (spawnPrompt === null) return;
    setBusy(true);
    setPickerError(null);
    rpc
      .call("canvas_spawn_thread", { prompt: spawnPrompt })
      .then((result) => bind(result.threadId))
      .catch((cause: unknown) => setPickerError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <div data-shape-body="bbthread" style={{ width: "100%", height: "100%", boxSizing: "border-box", position: "relative", border: "1px solid var(--border)", background: "var(--background)" }}>
      <div
        data-shape-frame-header=""
        style={{
          position: "absolute",
          left: -7,
          bottom: "100%",
          height: 24,
          maxWidth: "100%",
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          padding: "0 6px",
          fontSize: 12,
          borderRadius: 4,
          overflow: "hidden",
          whiteSpace: "nowrap",
          textOverflow: "ellipsis",
        }}
      >
        {bbthreadLabel(shape)}
      </div>
      <div data-canvas-bbthread="workspace" style={{ ...boundsStyle(layout.workspace), pointerEvents: "none" }} />
      <div
        data-canvas-bbthread="pane"
        {...interactiveAttrs}
        style={{
          ...boundsStyle(layout.pane),
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--border)",
          background: "var(--card)",
          overflow: "hidden",
          userSelect: interaction.interactive ? "text" : "none",
          // The viewport sets touch-action:none; re-enable native touch scrolling
          // inside the pane while it is the interactive island.
          touchAction: interaction.interactive ? "auto" : "none",
          cursor: interaction.interactive ? "auto" : "default",
          boxShadow: interaction.interactive ? "inset 0 0 0 2px var(--primary)" : "none",
        }}
      >
        <div
          style={{
            flex: `0 0 ${layout.paneHeaderRow.maxY - layout.paneHeaderRow.minY}px`,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            padding: "0 8px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          {pane.kind === "bound" ? (
            <>
              <span style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pane.title}</span>
              <TonePill tone={pane.tone} label={pane.statusLabel} />
            </>
          ) : (
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)" }}>
              {pane.kind === "unbound" ? "Pick a thread" : pane.kind === "loading" ? "Thread" : "Thread unavailable"}
            </span>
          )}
        </div>
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {pane.kind === "unbound" && (
            <UnboundPicker options={options} error={pickerError} query={query} onQuery={setQuery} onPick={bind} spawnDisabled={spawnPrompt === null} busy={busy} onSpawn={spawn} />
          )}
          {pane.kind === "loading" && <div style={{ padding: 8, fontSize: 11, color: "var(--muted-foreground)" }}>Loading…</div>}
          {pane.kind === "gone" && (
            <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 11, color: "var(--muted-foreground)" }}>This frame&apos;s thread is archived or no longer available.</div>
              <button
                data-canvas-bbthread="unbind"
                onClick={unbind}
                style={{ alignSelf: "flex-start", font: "inherit", fontSize: 12, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 4, background: "transparent", cursor: "pointer", color: "var(--foreground)" }}
              >
                Unbind
              </button>
            </div>
          )}
          {pane.kind === "bound" && threadId !== null && (
            <ThreadChat threadId={threadId} variant={chatVariant} layout="contained" className="bbthread-chat" focusRequest={focusRequest} />
          )}
        </div>
        <div
          style={{
            flex: `0 0 ${layout.paneFooter.maxY - layout.paneFooter.minY}px`,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            padding: "0 8px",
            borderTop: "1px solid var(--border)",
          }}
        >
          {pane.kind === "bound" && threadId !== null && (
            <>
              <span style={{ fontSize: 10, color: "var(--muted-foreground)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{threadId}</span>
              <button
                data-canvas-bbthread="open"
                onClick={() => openBbThread(threadId)}
                style={{ font: "inherit", fontSize: 11, fontWeight: 600, padding: 0, border: "none", background: "transparent", cursor: "pointer", color: "var(--primary)" }}
              >
                Open full →
              </button>
            </>
          )}
        </div>
        {interaction.hint !== null && (
          <div
            data-canvas-bbthread="hint"
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              pointerEvents: "none",
              padding: "3px 8px",
              fontSize: 10,
              color: "var(--muted-foreground)",
              background: "color-mix(in srgb, var(--card) 70%, transparent)",
              textAlign: "center",
            }}
          >
            {interaction.hint}
          </div>
        )}
      </div>
      {/* SIBLING of the pane div, not inside it (docs/plans/2026-09-15-bb-
          thread-frame.md's "Resizable pane" section): the pane carries
          `data-canvas-interactive` while focused, which makes canvas-react's
          viewport yield every pointer event whose DOM target lands inside it
          — a divider nested in the pane would never reach the canvas to
          resize anything. Rendered AFTER the pane in DOM order so it paints
          on top of the pane's own `borderLeft`. No pointer handlers: the
          select tool's `resizingPane` mode (canvas-editor) hit-tests this
          same band on the CANVAS side (`isPointOnBbthreadDivider`) and drives
          the resize from there. */}
      <div
        data-canvas-bbthread="divider"
        style={{
          ...boundsStyle(layout.divider),
          cursor: "ew-resize",
          background:
            "linear-gradient(to right, transparent calc(50% - 0.5px), var(--border) calc(50% - 0.5px), var(--border) calc(50% + 0.5px), transparent calc(50% + 0.5px))",
        }}
      />
    </div>
  );
}

function bbthreadPropsEqual(a: ShapeBodyProps, b: ShapeBodyProps): boolean {
  return (
    a.shape.id === b.shape.id &&
    stableStringify(a.shape) === stableStringify(b.shape) &&
    a.editorState.editingId === b.editorState.editingId &&
    a.editorState.editingRegion === b.editorState.editingRegion
  );
}

export const BbThreadShape = memo(BbThreadShapeInner, bbthreadPropsEqual);
