import os from "node:os";
import { AccessToken } from "livekit-server-sdk";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const NOT_CONFIGURED = "Set livekitUrl, livekitApiKey and livekitApiSecret with `bb plugin config huddle set …`.";
export const rpcContract = defineRpcContract({
  huddle_token: {
    input: z.object({ name: z.string().trim().min(1).max(64).optional() }).strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), url: z.string(), token: z.string(), room: z.string(), identity: z.string() }).strict(),
      z.object({ ok: z.literal(false), error: z.literal("not_configured"), detail: z.string() }).strict(),
    ]),
  },
});

/** LiveKit credentials and call lifecycle belong here, never in Canvas. */
export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    livekitUrl: { type: "string", label: "LiveKit URL", default: "" },
    livekitApiKey: { type: "string", label: "LiveKit API key", secret: true },
    livekitApiSecret: { type: "string", label: "LiveKit API secret", secret: true },
    room: { type: "string", label: "Huddle room", default: "bb-huddle" },
  });
  bb.rpc.register(rpcContract, {
    huddle_token: async ({ name }) => {
      const values = await settings.get();
      const url = (values.livekitUrl ?? "").trim();
      const apiKey = (values.livekitApiKey ?? "").trim();
      const apiSecret = (values.livekitApiSecret ?? "").trim();
      if (url === "" || apiKey === "" || apiSecret === "") return { ok: false as const, error: "not_configured" as const, detail: NOT_CONFIGURED };
      const identity = name ?? `local:${os.userInfo().username}`;
      const room = (values.room ?? "bb-huddle").trim() || "bb-huddle";
      const token = new AccessToken(apiKey, apiSecret, { identity, name: identity, ttl: "2h" });
      token.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true });
      return { ok: true as const, url, token: await token.toJwt(), room, identity };
    },
  });
}
