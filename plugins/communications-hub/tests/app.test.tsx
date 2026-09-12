// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadPluginApp,
  renderSlot,
  type PluginRpcTestHandlers,
} from "@get-bb/plugin-sdk/testing/app";
import { rpcContract } from "../src/contracts";
import type { Conversation, Registrant, Room, TranscriptSegment } from "../src/domain";

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
  roomId: null,
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

const room: Room = {
  id: "room-1",
  name: "Team standup",
  sourceId: "zoom",
  externalId: "88800011122",
  joinUrl: "https://zoom.us/j/88800011122?pwd=token",
  hostUser: "operator@example.com",
  createdAt: 1_700_000_000_000,
  archivedAt: null,
  expiresAt: 1_855_000_000_000,
  sourceDeletedAt: null,
};

const registrant: Registrant = {
  id: "registrant-1",
  roomId: "room-1",
  name: "David Laing",
  email: "david@example.com",
  externalId: "Zw5D8sBxQ1KqMnEAS2NuiQ",
  joinUrl: "https://zoom.us/w/88800011122?tk=token",
  createdAt: 1_700_000_050_000,
};

function handlers(
  overrides: Partial<PluginRpcTestHandlers<typeof rpcContract>> = {},
): PluginRpcTestHandlers<typeof rpcContract> {
  return {
    "rooms.list": () => ({ rooms: [room] }),
    "rooms.create": ({ name }) => ({ ...room, id: "room-2", name }),
    "rooms.archive": () => ({ ...room, archivedAt: 1_700_000_100_000 }),
    "rooms.renew": () => ({ ...room, expiresAt: 1_960_000_000_000 }),
    "rooms.delete": () => ({ ...room, archivedAt: 1_700_000_200_000, sourceDeletedAt: 1_700_000_200_000 }),
    "registrants.list": () => ({ registrants: [registrant] }),
    "registrants.add": ({ name, email }) => ({ ...registrant, id: "registrant-2", name, email }),
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
    "attachments.get": () => ({ attachment: null, conversation: null, room: null }),
    "attachments.set": ({ threadId, conversationId }) => ({
      threadId,
      roomId: null,
      conversationId,
      cursor: 0,
    }),
    "attachments.setRoom": ({ threadId, roomId }) => ({
      threadId,
      roomId,
      conversationId: null,
      cursor: 0,
    }),
    "attachments.detach": () => ({ ok: true }),
    "attachments.acknowledge": ({ threadId, conversationId, cursor }) => ({
      threadId,
      roomId: null,
      conversationId,
      cursor,
    }),
    "watch.get": () => ({ watch: null }),
    "watch.start": ({ threadId }) => ({
      threadId,
      conversationId: conversation.id,
      generation: "watch-generation-1",
      processedCursor: 0,
      lastAttemptAt: null,
    }),
    "watch.stop": () => ({ ok: true }),
    "capture.stop": () => ({ ...conversation, captureState: "stopped" }),
    "sources.status": () => ({
      ensembleworks: { enabled: false, conversationId: null },
      canvas: { enabled: false, conversationId: null, cursor: 0 },
      zoom: { configured: true, enabled: false, canCreateRooms: false },
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

    fireEvent.change(slot.getByLabelText("Choose a room or conversation"), {
      target: { value: "conversation:conversation-1" },
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

  it("starts and stops watching an attached conversation and shows its progress", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thread-a", params: null }, {
      rpc: handlers({
        "attachments.get": () => ({
          attachment: { threadId: "thread-a", roomId: null, conversationId: conversation.id, cursor: 0 },
          conversation,
          room: null,
        }),
        "watch.get": () => ({ watch: {
          threadId: "thread-a", conversationId: conversation.id, generation: "watch-generation-1",
          processedCursor: 7, lastAttemptAt: null,
        } }),
      }),
    });

    await slot.findByText("Watching · processed through passage 7");
    fireEvent.click(slot.getByRole("button", { name: "Stop watching" }));
    await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({
      method: "watch.stop", input: { threadId: "thread-a" },
    }));
    await slot.findByRole("button", { name: "Watch conversation" });
    fireEvent.click(slot.getByRole("button", { name: "Watch conversation" }));
    await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({
      method: "watch.start", input: { threadId: "thread-a" },
    }));
    await slot.findByText("Watching · processed through passage 0");
  });

  it("surfaces watch start failures", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thread-a", params: null }, {
      rpc: handlers({
        "attachments.get": () => ({
          attachment: { threadId: "thread-a", roomId: null, conversationId: conversation.id, cursor: 0 },
          conversation,
          room: null,
        }),
        "watch.start": () => { throw new Error("Give the thread a task before watching."); },
      }),
    });

    await slot.findByRole("button", { name: "Watch conversation" });
    fireEvent.click(slot.getByRole("button", { name: "Watch conversation" }));
    await waitFor(() => expect(slot.getByRole("alert").textContent).toContain("Give the thread a task"));
  });

  it("refreshes watch progress when the hub signals a conversation change", async () => {
    const app = await loadPluginApp(() => import("../app"));
    let processedCursor = 7;
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thread-a", params: null }, {
      rpc: handlers({
        "attachments.get": () => ({
          attachment: { threadId: "thread-a", roomId: null, conversationId: conversation.id, cursor: 0 },
          conversation,
          room: null,
        }),
        "watch.get": () => ({ watch: {
          threadId: "thread-a", conversationId: conversation.id, generation: "watch-generation-1",
          processedCursor, lastAttemptAt: null,
        } }),
      }),
    });

    await slot.findByText("Watching · processed through passage 7");
    processedCursor = 9;
    await slot.behavior.emitRealtime("communications-changed", { changed: true });
    await slot.findByText("Watching · processed through passage 9");
  });

  it("issues a personal link for a registered person", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: handlers() });

    await slot.findByText("Team standup");
    fireEvent.change(await slot.findByLabelText("Name for Team standup"), { target: { value: "Ada Lovelace" } });
    fireEvent.change(slot.getByLabelText("Email for Team standup"), { target: { value: "ada@example.com" } });
    fireEvent.click(slot.getByRole("button", { name: "Add person" }));

    await waitFor(() =>
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "registrants.add",
        input: { roomId: "room-1", name: "Ada Lovelace", email: "ada@example.com" },
      }),
    );
  });

  it("follows a room, and says so before anyone has met in it", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-a", params: null },
      { rpc: handlers() },
    );

    await slot.findByRole("option", { name: "Team standup" });
    fireEvent.change(slot.getByLabelText("Choose a room or conversation"), {
      target: { value: "room:room-1" },
    });
    // The button names the consequence: a room target follows, a conversation target does not.
    fireEvent.click(slot.getByRole("button", { name: "Follow room" }));

    await waitFor(() =>
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "attachments.setRoom",
        input: { threadId: "thread-a", roomId: "room-1" },
      }),
    );
    // A room nobody has met in resolves to no conversation, which is a normal state and not
    // an error: the thread is waiting for the first sitting.
    await slot.findByText(/Nobody has met in it yet/);
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
              roomId: null,
              conversationId: conversation.id,
              cursor: 7,
            },
            conversation,
            room: null,
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
            attachment: { threadId: "thread-a", roomId: null, conversationId: conversation.id, cursor: 0 },
            conversation,
            room: null,
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

it('opens live conversations at the tail and appends every incoming page without Load more', async () => {
  const app = await loadPluginApp(() => import('../app'));
  let rows = Array.from({length:45}, (_,i) => ({...segments[0]!, id:`live-${i+1}`, sequence:i+1, text:`Live speech ${i+1}`, speaker:`Speaker ${i+1}`}));
  const current = () => ({...conversation,captureState:'capturing' as const,segmentCount:rows.length});
  const slot = renderSlot(app.navPanels[0]!, {subPath:conversation.id}, {rpc:handlers({
    'conversations.get':current,
    'transcripts.read':({after=0,limit=20}) => {const rest=rows.filter(s=>s.sequence>after);const page=rest.slice(0,limit);return {conversation:current(),segments:page,hasMore:rest.length>limit,nextCursor:page.at(-1)?.sequence??after};},
  })});
  await slot.findByText('Live speech 45');
  expect(slot.queryByText('Live speech 1')).toBeNull();
  rows=[...rows,...Array.from({length:25},(_,i)=>({...segments[1]!,id:`new-${i}`,sequence:46+i,text:`New speech ${i}`,speaker:`New speaker ${i}`}))];
  await slot.behavior.emitRealtime('communications-changed',{changed:true});
  await slot.findByText('New speech 24');
  expect(slot.getByText('Live speech 45')).toBeTruthy();
  expect(slot.queryByRole('button',{name:'Load more'})).toBeNull();
  expect(slot.inspection.rpcCalls.some(c=>c.method==='attachments.acknowledge')).toBe(false);
  await slot.behavior.setRealtimeConnectionState('reconnecting');
  rows = [...rows, ...Array.from({length:210},(_,i)=>({...segments[0]!,id:`reconnected-${i}`,sequence:71+i,text:`Reconnected speech ${i}`,speaker:`Reconnected speaker ${i}`}))];
  await slot.behavior.setRealtimeConnectionState('connected');
  await slot.findByText('Reconnected speech 209');
  expect(slot.getByRole('list',{name:'Transcript passages'}).children.length).toBe(200);
  expect(slot.queryByText('Live speech 45')).toBeNull();
});

it('pauses when scrolling back and resumes at the latest speech without replacing search results', async () => {
  const app = await loadPluginApp(() => import('../app'));
  let rows = [...segments];
  const current = () => ({...conversation,captureState:'capturing' as const,segmentCount:rows.length});
  const slot = renderSlot(app.navPanels[0]!, {subPath:conversation.id}, {rpc:handlers({
    'conversations.get':current,
    'transcripts.read':({after=0}) => {const page=rows.filter(s=>s.sequence>after);return {conversation:current(),segments:page,hasMore:false,nextCursor:page.at(-1)?.sequence??after};},
  })});
  await slot.findByText(segments[1]!.text);
  const list = slot.getByRole('list',{name:'Transcript passages'});
  Object.defineProperties(list,{scrollHeight:{value:1000,configurable:true},clientHeight:{value:200,configurable:true}});
  fireEvent.scroll(list,{target:{scrollTop:100}});
  expect(slot.getByRole('button',{name:'Follow live'})).toBeTruthy();
  rows.push({...segments[0]!,id:'new-9',sequence:9,text:'New while paused',speaker:'New speaker'});
  await slot.behavior.emitRealtime('communications-changed',{changed:true});
  expect(slot.queryByText('New while paused')).toBeNull();
  fireEvent.click(slot.getByRole('button',{name:'Follow live'}));
  await slot.findByText('New while paused');
  fireEvent.change(slot.getByLabelText('Search transcript'),{target:{value:'citations'}});
  fireEvent.submit(slot.getByRole('search'));
  await slot.findByText('Results for “citations”');
  await slot.behavior.setRealtimeConnectionState('reconnecting');
  await slot.behavior.setRealtimeConnectionState('connected');
  expect(slot.getByText('Results for “citations”')).toBeTruthy();
  expect(slot.queryByText('New while paused')).toBeNull();
});

it('discards an in-flight live response when a search replaces it', async () => {
  const app = await loadPluginApp(() => import('../app'));
  let release: (()=>void) | undefined;
  let reads = 0;
  const slot = renderSlot(app.navPanels[0]!, {subPath:conversation.id}, {rpc:handlers({
    'conversations.get':()=>({...conversation,captureState:'capturing'}),
    'transcripts.read':async()=>{
      if (++reads > 1) await new Promise<void>(resolve=>{release=resolve;});
      return {conversation,segments,hasMore:false,nextCursor:8};
    },
  })});
  await slot.findByText(segments[0]!.text);
  await slot.behavior.emitRealtime('communications-changed',{changed:true});
  await waitFor(()=>expect(release).toBeDefined());
  fireEvent.change(slot.getByLabelText('Search transcript'),{target:{value:'citations'}});
  fireEvent.submit(slot.getByRole('search'));
  await slot.findByText('Results for “citations”');
  release!();
  await waitFor(()=>expect(slot.queryByText(segments[0]!.text)).toBeNull());
  expect(slot.getByText('Results for “citations”')).toBeTruthy();
});

it('renders EnsembleWorks point-timed speech as the same grouped speaker blocks', async () => {
  const app = await loadPluginApp(() => import('../app'));
  const pointSegments = interleavedSegments.map((segment, index) => ({
    ...segment, startMs: [1000,2000,3500][index]!, endMs:null,
  }));
  const current = {...conversation,sourceId:'ensembleworks',captureState:'capturing' as const,segmentCount:3};
  const slot = renderSlot(app.navPanels[0]!, {subPath:conversation.id}, {rpc:handlers({
    'conversations.get':()=>current,
    'transcripts.read':()=>({conversation:current,segments:pointSegments,hasMore:false,nextCursor:9}),
  })});
  await slot.findByText('Ship the transcript reader. And the reader ships Friday.');
  expect(slot.getByRole('list',{name:'Transcript passages'}).children.length).toBe(2);
  expect(slot.getByRole('button',{name:'Open citation 7–9'})).toBeTruthy();
});
