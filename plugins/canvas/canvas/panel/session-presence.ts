import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type MutableRefObject } from "react";
import type { Editor } from "@ensembleworks/canvas-editor";
import type { PresenceStore } from "@ensembleworks/canvas-sync";
import { toast } from "sonner";
import { adaptPresence } from "../identity.js";
import { buildRoster, cameraCenteredOn, panIntentFor } from "../roster.js";
import { canvasBus } from "../panel-bus.js";
import type { PresencePublisher } from "../presence-publisher.js";
import { PRESENCE_POLL_MS } from "./shared.js";

export function useSessionPresence({
  editor,
  presenceStore,
  presencePublisher,
  identities,
  selfKey,
  selfName,
  currentPageId,
  viewportSizeRef,
}: {
  readonly editor: Editor;
  readonly presenceStore: PresenceStore;
  readonly presencePublisher: PresencePublisher;
  readonly identities: Readonly<Record<string, string>>;
  readonly selfKey: string;
  readonly selfName: string | null;
  readonly currentPageId: string;
  readonly viewportSizeRef: MutableRefObject<{ width: number; height: number }>;
}) {
  const [presenceTick, setPresenceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setPresenceTick((tick) => tick + 1), PRESENCE_POLL_MS);
    return () => clearInterval(id);
  }, []);
  const presenceAll = useMemo(
    () => presenceStore.all(),
    [presenceStore, presenceTick],
  );
  const remotePresence = useMemo(
    () => adaptPresence(presenceAll, identities),
    [presenceAll, identities],
  );
  const roster = useMemo(
    () => buildRoster(identities, presenceAll, selfKey, selfName, currentPageId),
    [identities, presenceAll, selfKey, selfName, currentPageId],
  );
  useEffect(() => {
    canvasBus.setRoster(roster);
  }, [roster]);
  useEffect(() => () => canvasBus.clearRoster(), []);

  const av = useSyncExternalStore(
    canvasBus.subscribe,
    canvasBus.snapshot,
    canvasBus.snapshot,
  ).av;
  const currentPageIdRef = useRef(currentPageId);
  currentPageIdRef.current = currentPageId;
  useEffect(
    () =>
      canvasBus.setPanHandler((clientId) => {
        const intent = panIntentFor(
          presenceStore.all()[clientId],
          identities[clientId],
          currentPageIdRef.current,
        );
        if (intent.kind === "refuse") {
          toast.message(intent.message);
          return;
        }
        const { z } = editor.get().camera;
        editor.apply({
          type: "SetCamera",
          ...cameraCenteredOn(intent.point, viewportSizeRef.current, z),
        });
      }),
    [editor, presenceStore, identities],
  );
  useEffect(() => {
    presencePublisher.setPage(currentPageId);
  }, [presencePublisher, currentPageId]);
  useEffect(() => {
    const publish = () => {
      const { camera } = editor.get();
      const size = viewportSizeRef.current;
      presencePublisher.setViewport(
        { x: camera.x, y: camera.y, z: camera.z, w: size.width, h: size.height },
        camera,
      );
    };
    publish();
    return editor.subscribe(publish);
  }, [editor, presencePublisher]);

  return { presenceAll, remotePresence, av };
}
