import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const TAB_TTL_MS = 3_000;
const tabId = z.string().min(1).max(128);

export const rpcContract = defineRpcContract({
  presence_typing: {
    input: z.object({ tabId, threadId: z.string().min(1).max(200), active: z.boolean() }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  presence_typing_list: {
    input: z.object({ threadId: z.string().min(1).max(200) }).strict(),
    output: z.object({ count: z.number().int().nonnegative() }).strict(),
  },
});

/** Expiring, deliberately content-free typing awareness. */
export default async function plugin(bb: BbPluginApi) {
  const typing = new Map<string, { threadId: string; seenAt: number }>();
  const sweep = (now: number) => {
    for (const [id, value] of typing) if (now - value.seenAt > TAB_TTL_MS) typing.delete(id);
  };
  const count = (threadId: string) => {
    sweep(Date.now());
    return [...typing.values()].filter((value) => value.threadId === threadId).length;
  };
  bb.rpc.register(rpcContract, {
    presence_typing: ({ tabId, threadId, active }) => {
      if (active) typing.set(tabId, { threadId, seenAt: Date.now() });
      else typing.delete(tabId);
      sweep(Date.now());
      bb.realtime.publish("presence-typing", { threadId });
      return { ok: true } as const;
    },
    presence_typing_list: ({ threadId }) => ({ count: count(threadId) }),
  });
  bb.onDispose(() => typing.clear());
}
