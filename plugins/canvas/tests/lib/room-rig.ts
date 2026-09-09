// A real client peer talking to the real plugin backend, for suites that need
// to see a server-side write ARRIVE on a human's canvas.
//
// The pattern is tests/canvas-sync.test.ts's, lifted into a helper rather than
// re-derived: a `createBbTransport` whose `sendFrame` is an rpc call, and a
// pump that drains the fake host's realtime signals back into the transport.
// It is not imported by that suite — it was extracted for W4 and leaving the
// original in place keeps this refactor off a file the sync tests already
// guard.
import { SyncClientPeer } from "@ensembleworks/canvas-sync";
import type { FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { CANVAS_CHANNEL } from "../../canvas/wire.js";
import {
  createBbTransport,
  envelopeBytesFor,
  newPeerId,
  type BbTransport,
} from "../../transport.js";

export interface ConnectedPeer {
  readonly peer: SyncClientPeer;
  readonly transport: BbTransport;
  /** Run the exchange until it settles: a handshake is several round trips,
   * and so is "the server wrote something and told everybody". */
  pump(): Promise<void>;
}

function makePump(host: FakePluginHost, transport: BbTransport, id: string) {
  let drained = 0;
  return async function pump(): Promise<void> {
    for (let turn = 0; turn < 50; turn += 1) {
      await transport.flush();
      const signals = host.harness.inspection.realtimeSignals;
      if (drained >= signals.length) return;
      const batch = signals.slice(drained);
      drained = signals.length;
      for (const signal of batch) {
        if (signal.channel !== CANVAS_CHANNEL) continue;
        const bytes = envelopeBytesFor(id, signal.payload);
        if (bytes !== null) transport.deliver(bytes);
      }
    }
    throw new Error("pump did not settle");
  };
}

/** join + a real `SyncClientPeer` wired through this plugin's own transport. */
export async function connectPeer(
  host: FakePluginHost,
  id: string,
): Promise<ConnectedPeer> {
  const transport = createBbTransport({
    clientId: id,
    sendFrame: async (payload) => {
      await host.harness.behavior.callRpc("canvas_frame", payload);
    },
    onError: (error) => {
      throw error;
    },
  });
  await host.harness.behavior.callRpc("canvas_join", { clientId: id });
  const peer = new SyncClientPeer({ peerId: newPeerId(), transport });
  const pump = makePump(host, transport, id);
  await pump();
  await peer.ready();
  return { peer, transport, pump };
}
