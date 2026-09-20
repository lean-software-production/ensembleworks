import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { Editor, createToolContext, createToolSet } from "@ensembleworks/canvas-editor";
import { PresenceStore, SyncClientPeer } from "@ensembleworks/canvas-sync";
import { registerCoreShapes, registerShape } from "@ensembleworks/canvas-react";
import { BbThreadShape } from "../shapes/BbThreadShape.js";
import { GithubIssueShape } from "../shapes/GithubIssueShape.js";
import { createBbTransport, newPeerId, type BbTransport } from "../../transport.js";
import { fetchIdentity } from "../identity.js";
import { resolvePageId } from "../page.js";
import { readLastPage } from "../pages/last-page.js";
import { pageIdFromSubPath } from "../pages/page-route.js";
import { createPresencePublisher } from "../presence-publisher.js";
import { ROOM_ID } from "../wire.js";
import { pageMemoryStore } from "./page-memory.js";
import {
  READY_TIMEOUT_MS,
  Session,
  cryptoRandom,
  delay,
  joinInput,
} from "./shared.js";
import type { RpcClient } from "./connection-types.js";

export function useConnectionBoot({
  clientId,
  rpcRef,
  subPathRef,
  makeTransport,
  transportRef,
  sessionRef,
  setSession,
  setSelfName,
  selfNameRef,
  setError,
}: {
  readonly clientId: string;
  readonly rpcRef: MutableRefObject<RpcClient>;
  readonly subPathRef: MutableRefObject<string>;
  readonly makeTransport: () => BbTransport;
  readonly transportRef: MutableRefObject<BbTransport | null>;
  readonly sessionRef: MutableRefObject<Session | null>;
  readonly setSession: Dispatch<SetStateAction<Session | null>>;
  readonly setSelfName: Dispatch<SetStateAction<string | null>>;
  readonly selfNameRef: MutableRefObject<string | null>;
  readonly setError: Dispatch<SetStateAction<string | null>>;
}) {
  useEffect(() => {
    let cancelled = false;

    async function boot(): Promise<void> {
      const identity = await fetchIdentity();
      if (cancelled) return;
      selfNameRef.current = identity.name;
      setSelfName(identity.name);
      const transport = makeTransport();
      transportRef.current = transport;
      await rpcRef.current.call("canvas_join", joinInput(clientId, identity.name));
      if (cancelled) {
        transport.close();
        return;
      }
      const presenceStore = new PresenceStore(clientId);
      const peer = new SyncClientPeer({
        peerId: newPeerId(),
        transport,
        presence: presenceStore,
      });
      await Promise.race([peer.ready(), delay(READY_TIMEOUT_MS)]);
      if (cancelled) {
        presenceStore.destroy();
        peer.close();
        return;
      }
      const pageId = resolvePageId(
        peer.doc,
        pageIdFromSubPath(subPathRef.current),
        readLastPage(pageMemoryStore(), ROOM_ID),
      );
      const editor = new Editor({
        doc: peer.doc,
        now: () => performance.now(),
        random: cryptoRandom,
        pageId,
      });
      const toolContext = createToolContext(editor);
      registerCoreShapes();
      // Plugin-only shape (docs/plans/2026-09-15-bb-thread-frame.md): the
      // web app never registers this kind — see canvas-ui's Toolbar.tsx
      // TOOL_ORDER comment. Idempotent (registerShape overwrites, never
      // errors on a second call), so re-running this effect on reconnect is
      // safe.
      registerShape("bbthread", BbThreadShape);
      registerShape("github-issue", GithubIssueShape);
      const next: Session = {
        peer,
        editor,
        toolContext,
        tools: createToolSet(toolContext),
        presenceStore,
        presencePublisher: createPresencePublisher(presenceStore),
        selfKey: clientId,
      };
      sessionRef.current = next;
      setSession(next);
    }

    boot().catch((cause) => {
      if (cancelled) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      cancelled = true;
      const current = sessionRef.current;
      sessionRef.current = null;
      setSession(null);
      if (current) {
        current.toolContext.dispose();
        current.presencePublisher.dispose();
        current.peer.close();
        current.presenceStore.destroy();
      }
      transportRef.current?.close();
      transportRef.current = null;
      void rpcRef.current.call("canvas_leave", { clientId }).catch(() => {});
    };
  }, [clientId, makeTransport]);
}
