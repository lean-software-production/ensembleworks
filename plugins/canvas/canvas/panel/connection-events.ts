import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import {
  envelopeBytesFor,
  identitiesFrom,
  isResyncFor,
  serverHelloEpoch,
} from "../../transport.js";
import { CANVAS_CHANNEL } from "../wire.js";
import { KEEPALIVE_MS } from "./shared.js";
import type { RpcClient } from "./connection-types.js";
import type { BbTransport } from "../../transport.js";

export function useConnectionEvents({
  clientId,
  rpcRef,
  transportRef,
  resync,
  setIdentities,
}: {
  readonly clientId: string;
  readonly rpcRef: MutableRefObject<RpcClient>;
  readonly transportRef: MutableRefObject<BbTransport | null>;
  readonly resync: (reason: string) => void;
  readonly setIdentities: (identities: Record<string, string>) => void;
}) {
  const lastHelloRef = useRef<number | null>(null);
  const onRealtime = useCallback(
    (payload: unknown) => {
      const epoch = serverHelloEpoch(payload);
      if (epoch !== null) {
        if (lastHelloRef.current === epoch) return;
        lastHelloRef.current = epoch;
        resync("canvas server restarted");
        return;
      }
      if (isResyncFor(clientId, payload)) {
        resync("canvas session was dropped");
        return;
      }
      const names = identitiesFrom(payload);
      if (names !== null) {
        setIdentities(names);
        return;
      }
      const bytes = envelopeBytesFor(clientId, payload);
      if (bytes !== null) transportRef.current?.deliver(bytes);
    },
    [clientId, resync],
  );
  useRealtime(CANVAS_CHANNEL, onRealtime);

  useEffect(() => {
    const id = setInterval(() => {
      rpcRef.current
        .call("canvas_ping", { clientId })
        .then(({ connected }: { connected: boolean }) => {
          if (!connected) resync("canvas session expired");
        })
        .catch(() => {});
    }, KEEPALIVE_MS);
    return () => clearInterval(id);
  }, [clientId, resync]);

}
