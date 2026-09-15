import { useEffect, useRef } from "react";
import { useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";

export function useConnectionState({
  resync,
}: {
  readonly resync: (reason: string) => void;
}) {
  const connectionState = useRealtimeConnectionState();
  const previousConnectionState = useRef(connectionState);
  useEffect(() => {
    const previous = previousConnectionState.current;
    previousConnectionState.current = connectionState;
    if (connectionState !== "connected" || previous !== "reconnecting") return;
    resync("canvas reconnect");
  }, [connectionState, resync]);
  return connectionState;
}
