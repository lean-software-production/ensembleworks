// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

/** The browser half: each presence heartbeat carries the zone this BB client runs in. */

const app = await loadPluginApp(() => import("./app.js"));
const overlay = app.appOverlays.find((slot) => slot.id === "presence-coordinator")!;

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function heartbeats(): Promise<Array<Record<string, unknown>>> {
  const sent: Array<Record<string, unknown>> = [];
  await act(async () => {
    renderSlot(overlay, {}, {
      rpc: {
        presence_heartbeat: (input: unknown) => { sent.push(input as Record<string, unknown>); return { ok: true }; },
        presence_snapshot: () => ({ threads: [] }),
        presence_leave: () => ({ ok: true }),
        identity_thread_ownership: () => ({ threads: [] }),
      },
    });
  });
  return sent;
}

function browserZone(timeZone: string | undefined) {
  const real = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...real.call(this), timeZone } as Intl.ResolvedDateTimeFormatOptions;
  });
}

it("sends the browser's IANA time zone with the presence heartbeat", async () => {
  browserZone("America/Vancouver");
  const sent = await heartbeats();
  expect(sent.length).toBeGreaterThan(0);
  expect(sent[0]).toMatchObject({ timeZone: "America/Vancouver" });
});

it("leaves the zone out when the browser cannot say", async () => {
  browserZone(undefined);
  const sent = await heartbeats();
  expect(sent.length).toBeGreaterThan(0);
  expect(sent[0]).not.toHaveProperty("timeZone");
});
