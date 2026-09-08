import { useCallback, useEffect, useState } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { AGENT_CHANNEL, agentLinkFrom, agentUnlinkFrom, type CanvasAgentLink } from "../wire.js";
import type { ThreadOption } from "../thread-picker.js";
import type { RpcClient } from "./connection-types.js";

export function useAgentSync(rpcRef: { current: RpcClient }) {
  // Note -> agent-thread links, keyed by shape id. Seeded from the backend (so
  // badges are on screen the moment the panel mounts, not only for threads that
  // change status while it watches) and then kept live off AGENT_CHANNEL.
  const [agentLinks, setAgentLinks] = useState<Record<string, CanvasAgentLink>>({});
  const refreshAgents = useCallback(() => {
    rpcRef.current
      .call("canvas_agents")
      .then(({ links }: { links: CanvasAgentLink[] }) => {
        setAgentLinks(
          Object.fromEntries(links.map((link) => [link.shapeId, link])),
        );
      })
      // Badges are an enhancement, not the canvas: a failed refresh leaves the
      // last known set on screen rather than blanking it or nagging.
      .catch(() => {});
  }, []);
  useEffect(refreshAgents, [refreshAgents]);
  const dropAgentLink = useCallback((shapeId: string) => {
    setAgentLinks((previous) => {
      if (previous[shapeId] === undefined) return previous;
      const { [shapeId]: _dropped, ...rest } = previous;
      return rest;
    });
  }, []);
  useRealtime(
    AGENT_CHANNEL,
    useCallback(
      (payload: unknown) => {
        // Two message kinds share this channel; each decoder rejects the
        // other's payload, so the order of these two branches is not load
        // bearing (see wire.ts's CanvasAgentUnlink).
        const link = agentLinkFrom(payload);
        if (link !== null) {
          setAgentLinks((previous) => ({ ...previous, [link.shapeId]: link }));
          return;
        }
        const removal = agentUnlinkFrom(payload);
        if (removal !== null) dropAgentLink(removal.shapeId);
      },
      [dropAgentLink],
    ),
  );

  // The shape whose spawn is in flight, so the button can say so and a second
  // click cannot spawn a second thread for the same note.
  const [pendingShapeId, setPendingShapeId] = useState<string | null>(null);
  const runNote = useCallback((shapeId: string, text: string) => {
    setPendingShapeId(shapeId);
    rpcRef.current
      .call("canvas_run_note", { shapeId, text })
      .then((link: CanvasAgentLink) => {
        setAgentLinks((previous) => ({ ...previous, [link.shapeId]: link }));
      })
      .catch((cause: unknown) => {
        // A toast rather than the panel's error banner: the banner is about the
        // canvas CONNECTION being broken, and a refused spawn (no project, a
        // provider that will not start) leaves the canvas perfectly healthy.
        toast.error(
          `Could not run this note: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      })
      .finally(() => setPendingShapeId(null));
  }, []);

  /**
   * Break a note's link to its thread. Optimistic: the badge goes on click
   * rather than on the round trip, because the backend's broadcast is what
   * every OTHER tab reacts to and waiting for it here would leave the tab that
   * pressed the button as the last one still showing the badge.
   *
   * A failure puts it back — `canvas_agents` is the room's own answer, so the
   * refresh restores the badge if and only if the link really is still there.
   */
  const unlinkNote = useCallback(
    (shapeId: string) => {
      dropAgentLink(shapeId);
      rpcRef.current.call("canvas_unlink_agent", { shapeId }).catch((cause: unknown) => {
        toast.error(
          `Could not unlink this note: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        refreshAgents();
      });
    },
    [dropAgentLink, refreshAgents],
  );

  /**
   * Bind a shape to a thread that already exists in bb — the attach arm.
   *
   * NOT OPTIMISTIC, unlike `unlinkNote` above, and the asymmetry is the point:
   * an unlink is certain to succeed locally (the worst case is a badge that
   * comes back), whereas an attach can be REFUSED by the backend — the thread
   * may be archived, in another project, or already on another shape
   * (canvas/agent-attach.ts). Painting a badge before the verdict would show a
   * link the room does not have, on exactly the paths where the answer is no.
   */
  const attachThread = useCallback((shapeId: string, threadId: string) => {
    rpcRef.current
      .call("canvas_attach_thread", { shapeId, threadId })
      .then((link: CanvasAgentLink) => {
        setAgentLinks((previous) => ({ ...previous, [link.shapeId]: link }));
      })
      .catch((cause: unknown) => {
        // A toast, for the same reason a refused spawn gets one: the canvas
        // connection is perfectly healthy, so the error banner would be lying.
        toast.error(
          `Could not attach this shape: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      });
  }, []);

  /** The picker's offer. Fetched per open rather than cached: which threads
   * exist, and which are already spoken for, both change while the panel is
   * open, and a stale list would offer a thread whose attach is now refused. */
  const loadThreadOptions = useCallback(
    () =>
      rpcRef.current
        .call("canvas_thread_options", null)
        .then((result: { options: ThreadOption[] }) => result.options),
    [],
  );

  return { agentLinks, pendingShapeId, refreshAgents, runNote, unlinkNote, attachThread, loadThreadOptions };
}
