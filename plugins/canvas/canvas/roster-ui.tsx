// "Where are my teammates and how do I talk to them" — the two surfaces left
// here.
//
//   CanvasOnlineCount the navPanel's experimental_sidebarAccessory: a dot and a
//                     number in the sidebar row. It is mounted in every BB
//                     window whether or not the canvas is open, so it cannot use
//                     the bus at all — it seeds itself over rpc and stays live
//                     off the room's realtime identity broadcast.
//   SpeakerRings      a layer over the canvas: a ring on the cursor of whoever
//                     is talking, positioned exactly like AgentLayer's badges.
//
// THE THIRD SURFACE HAS MOVED OUT. `CanvasHeader` used to be the navPanel's
// `headerContent`: an avatar stack plus the audio control, rendered by BB into
// the shared page-header row. The presence strip (canvas/dock/dock.ts) now
// appends that same widget into that same row on EVERY bb route, so keeping
// this one would have drawn the roster twice on the canvas page and only
// there. Its one exclusive behaviour — clicking a face flies the camera to that
// person — went with it: the strip's popover faces carry the clientId
// canvasBus.panTo wants (`DockBubble.clientId` / `canPan` in
// canvas/dock/model.ts), so the gesture still lands on the canvas page and is
// still a harmless no-op everywhere else, where no panel is listening.
//
// Nothing here holds canvas state of its own.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { Camera } from "@ensembleworks/canvas-editor";
import type { Presence } from "@ensembleworks/canvas-sync";
import type { ViewportSize } from "@ensembleworks/canvas-react";
import { identitiesFrom } from "../transport.js";
import { onCanvasCount, speakerRingsFor } from "./roster.js";
import { CANVAS_CHANNEL } from "./wire.js";
import type { rpcContract } from "../server";

/**
 * The sidebar row's live count.
 *
 * This component is mounted in every BB window for as long as the plugin is
 * enabled — including windows that have never opened the canvas — so it must be
 * cheap and it cannot read canvasBus (which only has a roster while the panel is
 * mounted). It seeds itself with one rpc call and then follows the room's
 * identity broadcast, which is published on every join, leave and idle sweep.
 *
 * TWO SOURCES, ONE SET. Those two paths must count the same people or the
 * number changes without anybody moving. `canvas_roster` now lists every bb tab
 * (the location plumbing), so the seed reads the reply's `inRoom` flag — the
 * server's own statement of which clientIds are in `room.identities` — which is
 * exactly the set `identitiesFrom(payload)` carries.
 *
 * Renders NOTHING at zero. The host clips this slot to one short line beside
 * the sidebar row's title, and "0" there is a permanent piece of furniture
 * telling you nothing; the count earns its space only when somebody is on the
 * canvas.
 */
export function CanvasOnlineCount(): ReactNode {
  const rpc = useRpc<typeof rpcContract>();
  const [count, setCount] = useState(0);

  const refresh = useCallback(() => {
    rpc
      .call("canvas_roster", null)
      // `onCanvasCount`, NOT `members.length`: the roster answers "who is in
      // the building" (every bb tab reports its location there), and this badge
      // says "N on the canvas". Counting rows would make the seed and the
      // realtime handler below measure different sets, and the badge would
      // visibly change value on every join/leave/sweep publish.
      .then(({ members }) => setCount(onCanvasCount(members)))
      // A count is an ornament: a failed read keeps the last one rather than
      // flashing an error into the sidebar.
      .catch(() => {});
  }, [rpc]);
  useEffect(refresh, [refresh]);

  useRealtime(
    CANVAS_CHANNEL,
    useCallback((payload: unknown) => {
      const names = identitiesFrom(payload);
      if (names !== null) setCount(Object.keys(names).length);
    }, []),
  );

  // Realtime signals are ephemeral and never replayed, so every membership
  // change during a socket gap is simply gone — re-read on the way back.
  const connectionState = useRealtimeConnectionState();
  const [previous, setPrevious] = useState(connectionState);
  useEffect(() => {
    if (connectionState === previous) return;
    setPrevious(connectionState);
    if (connectionState === "connected" && previous === "reconnecting") refresh();
  }, [connectionState, previous, refresh]);

  if (count === 0) return null;
  return (
    <span
      className="flex items-center gap-1 text-[11px] tabular-nums text-muted-foreground"
      aria-label={`${count} on the canvas`}
      title={`${count} on the canvas`}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
      {count}
    </span>
  );
}

export interface SpeakerRingsProps {
  readonly presence: Readonly<Record<string, Presence>>;
  readonly identities: Readonly<Record<string, string>>;
  readonly speaking: readonly string[];
  readonly camera: Camera;
  readonly viewportSize: ViewportSize;
  readonly selfKey: string;
  /** The page the local view is showing (design doc D-4). Optional, matching
   * `speakerRingsFor` and canvas-react's `Cursors`: omitted means "not
   * page-aware", never "hide everybody". */
  readonly currentPageId?: string;
}

/**
 * A pulsing ring on the cursor of everyone who is talking.
 *
 * Plugin chrome layered over the viewport, exactly like AgentLayer: it cannot
 * be a canvas-react change (this spike consumes those packages unmodified) and
 * it must not be a shape (who is talking is ephemeral bb state, not document
 * content). `pointer-events: none` throughout — a ring is never a target.
 */
export function SpeakerRings({
  presence,
  identities,
  speaking,
  camera,
  viewportSize,
  selfKey,
  currentPageId,
}: SpeakerRingsProps): ReactNode {
  const rings = speakerRingsFor(
    presence,
    identities,
    speaking,
    camera,
    viewportSize,
    selfKey,
    currentPageId,
  );
  if (rings.length === 0) return null;
  return (
    <div
      data-canvas-layer="speakers"
      className="absolute inset-0"
      style={{ pointerEvents: "none" }}
    >
      {rings.map((ring) => (
        <span
          key={ring.clientId}
          data-canvas-speaker={ring.name}
          aria-hidden
          className="absolute animate-pulse rounded-full"
          style={{
            left: ring.left,
            top: ring.top,
            width: 28,
            height: 28,
            // Centred on the cursor HOTSPOT, so the ring reads as being around
            // the pointer rather than hanging off its tail.
            transform: "translate(-30%, -30%)",
            border: `2px solid ${ring.color}`,
          }}
        />
      ))}
    </div>
  );
}
