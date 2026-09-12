import { useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./rpc-contract.js";

type Excerpts = Readonly<Record<string, { readonly text: string; readonly label: string }>>;

/** One bounded read for visible cards; never mount a chat or fetch on camera frames. */
export function useThreadExcerpts(threadIds: readonly string[]): Excerpts {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const key = JSON.stringify([...new Set(threadIds)].sort().slice(0, 20));
  const [result, setResult] = useState<{ key: string; excerpts: Excerpts }>({ key: "", excerpts: {} });
  useEffect(() => {
    const ids = JSON.parse(key) as string[];
    if (ids.length === 0) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      if (disposed) return;
      if (document.visibilityState !== "hidden") {
        try {
          const excerpts = await rpcRef.current.call("canvas_thread_excerpts", { threadIds: ids });
          if (!disposed) setResult({ key, excerpts });
        } catch {
          // Do not present an old response as a successfully refreshed excerpt.
          if (!disposed) setResult({ key, excerpts: {} });
        }
      }
      if (!disposed) timer = setTimeout(refresh, 15_000);
    }
    // Debounce panning across card boundaries.
    timer = setTimeout(refresh, 200);
    return () => { disposed = true; clearTimeout(timer); };
  }, [key]);
  return result.key === key ? result.excerpts : {};
}
