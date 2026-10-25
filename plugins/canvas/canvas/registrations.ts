import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  CF_ACCESS_EMAIL_HEADER,
  IDENTITY_ROUTE_PATH,
  resolveIdentity,
} from "./identity.js";
import type { CanvasRoomHost } from "./room.js";
import { CANVAS_CHANNEL } from "./wire.js";
import os from "node:os";

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export function registerBackground(
  bb: BbPluginApi,
  room: CanvasRoomHost,
): void {
  bb.background.service("canvas-gc", {
    async start(signal) {
      bb.realtime.publish(CANVAS_CHANNEL, { hello: Date.now() });
      while (!signal.aborted) {
        await sleep(30_000, signal);
        if (signal.aborted) break;
        room.sweep(Date.now());
      }
    },
  });
}

export function registerHttp(bb: BbPluginApi): void {
  bb.http.route(
    "GET",
    IDENTITY_ROUTE_PATH,
    (context) =>
      context.json(
        resolveIdentity(
          context.req.header(CF_ACCESS_EMAIL_HEADER),
          os.userInfo().username,
        ),
      ),
  );
}
