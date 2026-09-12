// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadPluginApp,
  renderSlot,
  type PluginRpcTestHandlers,
} from "@get-bb/plugin-sdk/testing/app";
import { rpcContract } from "../src/contracts";
import type { Conversation, TranscriptSegment } from "../src/domain";

const conversation: Conversation = {
  id: "conversation-1",
  title: "Weekly planning",
  sourceId: "import",
  externalId: "upload-1",
  createdAt: Date.UTC(2026, 8, 10, 9),
  captureStartedAt: null,
  lastReceivedAt: Date.UTC(2026, 8, 10, 9, 5),
  captureState: "idle",
  captureDetail: null,
  captureEndedAt: null,
  interruptionCount: 0,
  segmentCount: 2,
};

const segments: TranscriptSegment[] = [
  {
    id: "segment-7",
    conversationId: conversation.id,
    sequence: 7,
    sourceKey: "cue-7",
    speakerId: null,
    speaker: "Ada",
    text: "Ship the transcript reader.",
    startMs: 12_000,
    endMs: 15_000,
    receivedAt: Date.UTC(2026, 8, 10, 9, 5),
  },
  {
    id: "segment-8",
    conversationId: conversation.id,
    sequence: 8,
    sourceKey: "cue-8",
    speakerId: null,
    speaker: "Ben",
    text: "Add stable citations too.",
    startMs: 16_000,
    endMs: 19_000,
    receivedAt: Date.UTC(2026, 8, 10, 9, 5),
  },
];

/** Ada finishes her sentence after Ben's interjection, as speakers really do. */
const interleavedSegments: TranscriptSegment[] = [
  segments[0]!,
  segments[1]!,
  {
    id: "segment-9",
    conversationId: conversation.id,
    sequence: 9,
    sourceKey: "cue-9",
    speakerId: null,
    speaker: "Ada",
    text: "And the reader ships Friday.",
    startMs: 17_500,
    endMs: 22_000,
    receivedAt: Date.UTC(2026, 8, 10, 9, 5),
  },
];

function handlers(
  overrides: Partial<PluginRpcTestHandlers<typeof rpcContract>> = {},
): PluginRpcTestHandlers<typeof rpcContract> {
  return {
    "conversations.list": () => ({
      conversations: [conversation],
      hasMore: false,
      nextOffset: 1,
    }),
    "conversations.get": () => conversation,
    "conversations.rename": ({ title }: { title: string }) => ({ ...conversation, title }),
    "transcripts.import": () => conversation,
    "transcripts.read": () => ({
      conversation,
      segments,
      hasMore: false,
      nextCursor: 8,
    }),
    "transcripts.search": () => ({
      conversation,
      segments: [segments[1]!],
      hasMore: false,
      nextCursor: 8,
    }),
    "attachments.get": () => ({ attachment: null, conversation: null }),
    "attachments.set": ({ threadId, conversationId }) => ({
      threadId,
      conversationId,
      cursor: 0,
    }),
    "attachments.detach": () => ({ ok: true }),
    "attachments.acknowledge": ({ threadId, conversationId, cursor }) => ({
      threadId,
      conversationId,
      cursor,
    }),
    "capture.stop": () => ({ ...conversation, captureState: "stopped" }),
    "sources.status": () => ({
      zoom: { configured: true, enabled: false },
      webhookPath: "/plugins/communications-hub/webhooks/zoom",
      importReady: true,
    }),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe("Communications Hub app", () => {
  it("registers the Communications navigation and thread surfaces", async () => {
    const app = await loadPluginApp(() => import("../app"));

    expect(app.navPanels.map(({ id, path, title }) => ({ id, path, title }))).toEqual([
      { id: "communications", path: "communications", title: "Communications" },
    ]);
    expect(app.threadPanelActions.map(({ id, title }) => ({ id, title }))).toEqual([
      { id: "conversation", title: "Conversation" },
    ]);
    expect(app.threadHeaderActions.map(({ id, title }) => ({ id, title }))).toEqual([
      { id: "conversation", title: "Conversation" },
    ]);
  });

  it("imports pasted text and then opens the resulting conversation", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      { rpc: handlers() },
    );

    await slot.findByText("Weekly planning");
    expect(slot.getByText("Import ready")).toBeTruthy();
    expect(slot.getByText("Zoom configured")).toBeTruthy();
    expect(slot.getByText("Zoom disabled")).toBeTruthy();

    fireEvent.change(slot.getByLabelText("Conversation title"), {
      target: { value: "Customer call" },
    });
    fireEvent.change(slot.getByLabelText("Transcript text"), {
      target: { value: "Ada: The launch is Friday." },
    });
    fireEvent.click(slot.getByRole("button", { name: "Import transcript" }));

    await waitFor(() => {
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "transcripts.import",
        input: {
          title: "Customer call",
          format: "txt",
          text: "Ada: The launch is Friday.",
        },
      });
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "communications",
        options: { subPath: "conversation-1" },
      });
    });
  });

  it("opens a citation deep link at the referenced segment", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "conversation-1/7" },
      { rpc: handlers() },
    );

    await slot.findByText("Ship the transcript reader.");
    expect(slot.inspection.rpcCalls).toContainEqual({
      method: "transcripts.read",
      input: { conversationId: "conversation-1", after: 6, limit: 20 },
    });
    expect(slot.getByText("Referenced passage")).toBeTruthy();
    expect(slot.getByText("+0:12")).toBeTruthy();
  });

  it("renames a conversation from the transcript view", async () => {
    // Zoom names a capture after its meeting id and start; only a human can name the
    // discussion. The title has to be editable where it is read.
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "conversation-1" }, { rpc: handlers() });
    await slot.findByText("Ship the transcript reader.");

    fireEvent.click(slot.getByRole("button", { name: "Rename conversation" }));
    fireEvent.change(slot.getByLabelText("Conversation title"), {
      target: { value: "Attribution design" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));

    await slot.findByText("Attribution design");
    expect(slot.inspection.rpcCalls).toContainEqual({
      method: "conversations.rename",
      input: { conversationId: "conversation-1", title: "Attribution design" },
    });
  });

  it("uses a transcript file extension as the import format", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: handlers() });
    await slot.findByText("Weekly planning");
    const file = new File(["WEBVTT\n\n00:00.000 --> 00:01.000\nHello"], "Planning.vtt");
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new TextEncoder().encode("WEBVTT\n\n00:00.000 --> 00:01.000\nHello").buffer,
    });

    fireEvent.change(slot.getByLabelText("Transcript file"), { target: { files: [file] } });
    await waitFor(() => expect((slot.getByLabelText("Transcript format") as HTMLSelectElement).value).toBe("vtt"));
    expect((slot.getByLabelText("Conversation title") as HTMLInputElement).value).toBe("Planning");
    fireEvent.click(slot.getByRole("button", { name: "Import transcript" }));

    await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({
      method: "transcripts.import",
      input: {
        title: "Planning",
        format: "vtt",
        text: "WEBVTT\n\n00:00.000 --> 00:01.000\nHello",
      },
    }));
  });

  it("rejects a file larger than 1 MB before reading it", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: handlers() });
    await slot.findByText("Weekly planning");
    const read = vi.fn();
    const file = new File(["x"], "oversized.txt");
    Object.defineProperties(file, {
      size: { value: 1_000_001 },
      arrayBuffer: { value: read },
    });

    fireEvent.change(slot.getByLabelText("Transcript file"), { target: { files: [file] } });

    expect((await slot.findByRole("alert")).textContent).toContain("at most 1 MB");
    expect(read).not.toHaveBeenCalled();
    expect(slot.inspection.rpcCalls.some(({ method }) => method === "transcripts.import")).toBe(false);
  });

  it("warns when an interrupted capture may have transcript gaps", async () => {
    const interrupted = { ...conversation, sourceId: "zoom", interruptionCount: 2 };
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: interrupted.id }, {
      rpc: handlers({
        "transcripts.read": () => ({
          conversation: interrupted,
          segments,
          hasMore: false,
          nextCursor: 8,
        }),
      }),
    });

    expect((await slot.findByText(/Capture was interrupted 2 times/)).textContent).toContain(
      "transcript may have gaps",
    );
  });

  it("attaches a conversation without acknowledging and offers no acknowledge control", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-a", params: null },
      { rpc: handlers() },
    );

    await slot.findByRole("option", { name: "Weekly planning" });
    expect(
      slot.inspection.rpcCalls.some(({ method }) => method === "attachments.acknowledge"),
    ).toBe(false);

    fireEvent.change(slot.getByLabelText("Choose conversation"), {
      target: { value: "conversation-1" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Attach conversation" }));
    await slot.findByText("Ship the transcript reader.");
    expect(
      slot.inspection.rpcCalls.some(({ method }) => method === "attachments.acknowledge"),
    ).toBe(false);

    expect(
      slot.queryByRole("button", { name: /Acknowledge through passage/ }),
    ).toBeNull();
    expect(
      (await slot.findByText(/Reading cursor: passage/)).textContent,
    ).toContain("Reading and search do not acknowledge passages automatically.");
  });

  it("shows per-thread attachment state in the header and opens the panel", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.threadHeaderActions[0]!,
      { threadId: "thread-a", projectId: "project-a", isCompactViewport: false },
      {
        rpc: handlers({
          "attachments.get": () => ({
            attachment: {
              threadId: "thread-a",
              conversationId: conversation.id,
              cursor: 7,
            },
            conversation,
          }),
        }),
        openThreadPanel: () => true,
      },
    );

    const button = await slot.findByRole("button", {
      name: "Open attached conversation Weekly planning",
    });
    fireEvent.click(button);
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "openThreadPanel",
      options: { actionId: "conversation" },
    });
  });

  it("groups a speaker's passages across an interjection and sends one to the composer", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-a", params: null },
      {
        rpc: handlers({
          "attachments.get": () => ({
            attachment: { threadId: "thread-a", conversationId: conversation.id, cursor: 0 },
            conversation,
          }),
          "transcripts.read": () => ({
            conversation,
            segments: interleavedSegments,
            hasMore: false,
            nextCursor: 9,
          }),
        }),
      },
    );

    // Ada's two passages read as one, and Ben's interjection stays separate.
    await slot.findByText("Ship the transcript reader. And the reader ships Friday.");
    slot.getByText("Add stable citations too.");
    slot.getByText("#7–9");

    fireEvent.click(
      slot.getByRole("button", { name: "Send passage #7–9 to the thread composer" }),
    );
    await waitFor(() => expect(slot.inspection.composer.text).toContain("passages 7–9 — Ada"));
    expect(slot.inspection.composer.text).toContain(
      "> Ship the transcript reader. And the reader ships Friday.",
    );
    // Quoting is not sending: nothing was dispatched to the provider.
    expect(slot.inspection.composer.submits).toHaveLength(0);
  });

  it("cites a grouped passage as a range and opens every block the range touches", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const rpc = handlers({
      "transcripts.read": () => ({
        conversation,
        segments: interleavedSegments,
        hasMore: false,
        nextCursor: 9,
      }),
    });
    const listing = renderSlot(app.navPanels[0]!, { subPath: "conversation-1" }, { rpc });
    await listing.findByText("Ship the transcript reader. And the reader ships Friday.");
    fireEvent.click(listing.getByRole("button", { name: "Open citation 7–9" }));
    expect(listing.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "communications",
      options: { subPath: "conversation-1/7-9" },
    });

    const cited = renderSlot(app.navPanels[0]!, { subPath: "conversation-1/7-9" }, { rpc });
    await cited.findByText("Ship the transcript reader. And the reader ships Friday.");
    // Ben's passage 8 falls inside the cited range, so it is marked too.
    expect(cited.getAllByText("Referenced passage")).toHaveLength(2);
  });

  it("rejects a malformed citation range", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "conversation-1/9-7" }, { rpc: handlers() });
    await slot.findByText("This conversation link is invalid.");
  });
});
