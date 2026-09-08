import { useEffect, useRef } from "react";
import { useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";

export function useConnectionState({
  resync,
  refreshAgents,
}: {
  readonly resync: (reason: string) => void;
  readonly refreshAgents: () => void;
}) {
  const connectionState = useRealtimeConnectionState();
  const previousConnectionState = useRef(connectionState);
  useEffect(() => {
    const previous = previousConnectionState.current;
    previousConnectionState.current = connectionState;
    if (connectionState !== "connected" || previous !== "reconnecting") return;
    resync("canvas reconnect");
    refreshAgents();
  }, [connectionState, resync, refreshAgents]);
  return connectionState;
}
