import { useCallback, useRef, useState } from "react";
import { useRpc, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import {
  createBbTransport,
  type BbTransport,
} from "../../transport.js";
import type { rpcContract } from "../../server";
import { tabClientId } from "../tab-id.js";
import { useAgentSync } from "./agent-sync.js";
import { useConnectionBoot } from "./connection-boot.js";
import { useConnectionEvents } from "./connection-events.js";
import { useConnectionState } from "./connection-state.js";
import type { RpcClient } from "./connection-types.js";
import { Session, joinInput } from "./shared.js";

export function useCanvasConnection({ subPath }: Pick<PluginNavPanelProps, "subPath">) {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef<RpcClient>(rpc);
  rpcRef.current = rpc;
  const subPathRef = useRef(subPath);
  subPathRef.current = subPath;
  const clientId = tabClientId();
  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const transportRef = useRef<BbTransport | null>(null);
  const [selfName, setSelfName] = useState<string | null>(null);
  const selfNameRef = useRef<string | null>(null);
  const [identities, setIdentities] = useState<Record<string, string>>({});
  const agents = useAgentSync(rpcRef);
  const makeTransport = useCallback(
    (): BbTransport =>
      createBbTransport({
        clientId,
        sendFrame: (payload) => rpcRef.current.call("canvas_frame", payload),
        onError: (cause) =>
          setError(cause instanceof Error ? cause.message : String(cause)),
      }),
    [clientId],
  );
  const resyncInFlight = useRef(false);
  const resync = useCallback(
    (reason: string) => {
      const current = sessionRef.current;
      if (current === null || resyncInFlight.current) return;
      resyncInFlight.current = true;
      const transport = makeTransport();
      rpcRef.current
        .call("canvas_join", joinInput(clientId, selfNameRef.current))
        .then(() => {
          if (sessionRef.current !== current) {
            transport.close();
            return;
          }
          transportRef.current = transport;
          current.peer.reconnect(transport);
          setError(null);
        })
        .catch((cause: unknown) => {
          setError(`${reason}: ${cause instanceof Error ? cause.message : String(cause)}`);
        })
        .finally(() => {
          resyncInFlight.current = false;
        });
    },
    [clientId, makeTransport],
  );
  useConnectionEvents({
    clientId,
    rpcRef,
    transportRef,
    resync,
    setIdentities,
  });
  useConnectionBoot({
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
  });
  const connectionState = useConnectionState({
    resync,
    refreshAgents: agents.refreshAgents,
  });
  return { session, error, connectionState, identities, selfName, agents };
}
