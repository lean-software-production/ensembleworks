import {
  useCallback, useEffect, useRef, useState,
  type ChangeEvent, type FormEvent, type ReactNode,
} from "react";
import {
  definePluginApp, useBbNavigate, useComposer, useRealtime, useRealtimeConnectionState, useRpc,
  type PluginNavPanelProps, type PluginThreadHeaderActionProps, type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./src/contracts";
import type { Conversation, ThreadAttachment, TranscriptSegment } from "./src/domain";
import { groupSegments, type SpeakerBlock } from "./src/grouping";
import type { ImportFormat } from "./src/adapters/import";
import { Button } from "./components/ui/button";
import { Icon } from "./components/ui/icon";
import { Input } from "./components/ui/input";
import { cn } from "./lib/utils";

const PAGE_SIZE = 20;
const MAX_FILE_BYTES = 1_000_000;

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const sourceLabel = (id: string) => id === "import" ? "Imported" : id === "zoom" ? "Zoom" : id;
const captureLabel = (state: Conversation["captureState"]) =>
  state === "idle" ? "Imported transcript" : state[0]!.toUpperCase() + state.slice(1);

function freshness(value: number | null) {
  if (value === null) return "No transcript received";
  const elapsed = Math.max(0, Date.now() - value);
  if (elapsed < 60_000) return "Updated just now";
  if (elapsed < 3_600_000) return `Updated ${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `Updated ${Math.floor(elapsed / 3_600_000)}h ago`;
  return `Updated ${new Date(value).toLocaleDateString()}`;
}

function relativeTime(value: number | null) {
  if (value === null) return null;
  const seconds = Math.floor(value / 1_000);
  return `+${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function StatusBox({ children }: { children: ReactNode }) {
  return <div role="status" className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">{children}</div>;
}

function ErrorMessage({ error }: { error: string | null }) {
  return error === null ? null : <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>;
}

/** Coalesce status-only notifications so a busy capture cannot flood RPC. */
function useChangedSignal(refetch: () => void) {
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const changed = useCallback(() => {
    const remaining = 1_000 - (Date.now() - last.current);
    if (remaining <= 0) {
      last.current = Date.now();
      refetch();
    } else if (timer.current === null) {
      timer.current = setTimeout(() => {
        timer.current = null;
        last.current = Date.now();
        refetch();
      }, remaining);
    }
  }, [refetch]);
  useRealtime("communications-changed", changed);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);
}

type Page = {
  conversation: Conversation;
  segments: TranscriptSegment[];
  hasMore: boolean;
  nextCursor: number;
};

function TranscriptView({
  conversationId, initialSequence, initialEndSequence, compact = false, onPage, onSend,
}: {
  conversationId: string;
  initialSequence?: number;
  /** Last passage of a cited range; a single-passage citation omits it. */
  initialEndSequence?: number;
  compact?: boolean;
  onPage?: (page: Page) => void;
  /** Offered per passage when the surface has a composer to write into. */
  onSend?: (block: SpeakerBlock) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [page, setPage] = useState<Page | null>(null);
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState<string | null>(null);
  const onPageRef = useRef(onPage);
  onPageRef.current = onPage;

  // Zoom's RTMS events carry no meeting topic, so a capture can only name itself after its
  // meeting id and start. Renaming is what makes a conversation findable months later.
  const rename = useCallback(async (title: string) => {
    const next = title.trim();
    setDraftTitle(null);
    if (!next) return;
    try {
      const conversation = await rpc.call("conversations.rename", { conversationId, title: next });
      setPage((current) => current === null ? current : { ...current, conversation });
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [conversationId, rpc]);

  const accept = useCallback((next: Page, append: boolean) => {
    setPage((current) => append && current !== null
      ? { ...next, segments: [...current.segments, ...next.segments] }
      : next);
    onPageRef.current?.(next);
    setError(null);
  }, []);

  const read = useCallback(async (after: number, append = false) => {
    setPending(true);
    try {
      const next = await rpc.call("transcripts.read", { conversationId, after, limit: PAGE_SIZE });
      setActiveQuery("");
      accept(next, append);
    } catch (cause) {
      setError(errorText(cause));
      if (!append) setPage(null);
    } finally {
      setPending(false);
    }
  }, [accept, conversationId, rpc]);

  const startAfter = Math.max(0, (initialSequence ?? 1) - 1);
  useEffect(() => { void read(startAfter); }, [read, startAfter]);
  const refresh = useCallback(() => { void read(startAfter); }, [read, startAfter]);
  useChangedSignal(refresh);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    const value = query.trim();
    if (value === "") return void read(0);
    setPending(true);
    try {
      const next = await rpc.call("transcripts.search", {
        conversationId, query: value, after: 0, limit: PAGE_SIZE,
      });
      setActiveQuery(value);
      accept(next, false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };

  const loadMore = async () => {
    if (page === null) return;
    setPending(true);
    try {
      const next = activeQuery === ""
        ? await rpc.call("transcripts.read", { conversationId, after: page.nextCursor, limit: PAGE_SIZE })
        : await rpc.call("transcripts.search", {
            conversationId, query: activeQuery, after: page.nextCursor, limit: PAGE_SIZE,
          });
      accept(next, true);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };

  // Presentation only: segments stay immutable and each member sequence still
  // cites on its own.
  const blocks = page === null ? [] : groupSegments(page.segments);

  if (page === null && error === null) return <StatusBox>Loading transcript…</StatusBox>;
  return (
    <section aria-label="Transcript" className="space-y-3">
      {page === null ? null : (
        <div>
          <div className="flex flex-wrap items-center gap-2">
            {draftTitle === null ? (
              <>
                <h2 className={cn("font-semibold", compact ? "text-base" : "text-lg")}>{page.conversation.title}</h2>
                <button
                  type="button"
                  aria-label="Rename conversation"
                  className="text-xs underline text-muted-foreground hover:text-foreground"
                  onClick={() => setDraftTitle(page.conversation.title)}
                >Rename</button>
              </>
            ) : (
              <form
                className="flex flex-1 gap-2"
                onSubmit={(event) => { event.preventDefault(); void rename(draftTitle); }}
              >
                <Input
                  autoFocus
                  aria-label="Conversation title"
                  value={draftTitle}
                  maxLength={200}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Escape") setDraftTitle(null); }}
                />
                <Button type="submit" size="sm" disabled={!draftTitle.trim()}>Save</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setDraftTitle(null)}>Cancel</Button>
              </form>
            )}
            <span className="rounded-full bg-secondary px-2 py-0.5 text-xs">{captureLabel(page.conversation.captureState)}</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {page.conversation.segmentCount} passages · {freshness(page.conversation.lastReceivedAt)}
          </p>
          {page.conversation.interruptionCount > 0 ? (
            <p role="status" className="mt-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
              Capture was interrupted {page.conversation.interruptionCount} {page.conversation.interruptionCount === 1 ? "time" : "times"}; transcript may have gaps.
            </p>
          ) : null}
          {page.conversation.captureDetail ? <p className="mt-1 text-xs text-muted-foreground">{page.conversation.captureDetail}</p> : null}
        </div>
      )}
      <form onSubmit={(event) => void search(event)} role="search" className="flex gap-2">
        <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search transcript" placeholder="Search transcript" />
        <Button type="submit" variant="outline" disabled={pending}><Icon name="Search" /> Search</Button>
      </form>
      {activeQuery ? (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>Results for “{activeQuery}”</span>
          <button type="button" className="underline hover:text-foreground" onClick={() => void read(0)}>Clear search</button>
        </div>
      ) : null}
      <ErrorMessage error={error} />
      {page !== null && page.segments.length === 0 ? <StatusBox>{activeQuery ? "No matching passages." : "No transcript passages yet."}</StatusBox> : null}
      {page !== null && page.segments.length > 0 ? (
        <ol className="divide-y divide-border rounded-lg border border-border bg-card">
          {blocks.map((block) => {
            // A cited range highlights every block it touches, so a quote that
            // spans passages lands on all of them rather than just the first.
            const referenced = initialSequence !== undefined && block.sequences.some(
              (sequence) => sequence >= initialSequence && sequence <= (initialEndSequence ?? initialSequence),
            );
            const citation = block.firstSequence === block.lastSequence
              ? `${block.firstSequence}`
              : `${block.firstSequence}-${block.lastSequence}`;
            const label = block.sequences.length === 1
              ? `#${block.firstSequence}`
              : `#${block.firstSequence}–${block.lastSequence}`;
            return (
              <li key={block.firstSequence} className={cn("px-3 py-3", referenced && "bg-accent")} aria-current={referenced ? "location" : undefined}>
                <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono" title={block.sequences.length === 1 ? undefined : `Passages ${block.sequences.join(", ")}`}>{label}</span>
                  {block.speaker ? <span className="font-medium text-foreground">{block.speaker}</span> : null}
                  {relativeTime(block.startMs) ? <span title="Source-relative timing">{relativeTime(block.startMs)}</span> : null}
                  {referenced ? <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">Referenced passage</span> : null}
                  <span className="ml-auto flex items-center gap-2">
                    {onSend ? (
                      <button
                        type="button" className="underline hover:text-foreground"
                        aria-label={`Send passage ${label} to the thread composer`}
                        onClick={() => onSend(block)}
                      >Send to thread</button>
                    ) : null}
                    <button
                      type="button" className="underline hover:text-foreground"
                      aria-label={`Open citation ${label.replace("#", "")}`}
                      onClick={() => navigate.toPluginPanel("communications", { subPath: `${conversationId}/${citation}` })}
                    >Citation</button>
                  </span>
                </div>
                <p className="whitespace-pre-wrap text-sm leading-6">{block.text}</p>
              </li>
            );
          })}
        </ol>
      ) : null}
      {page?.hasMore ? <Button type="button" variant="outline" disabled={pending} onClick={() => void loadMore()}>{pending ? "Loading…" : "Load more"}</Button> : null}
    </section>
  );
}

/** A citation addresses one passage (`7`) or a speaker's run of them (`7-9`). */
export function parseTarget(
  subPath: string,
): { conversationId: string; sequence?: number; endSequence?: number } | null {
  const [rawId, rawSequence, ...rest] = subPath.split("/");
  if (!rawId || rest.length > 0) return null;
  let conversationId: string;
  try {
    conversationId = decodeURIComponent(rawId);
  } catch {
    return null;
  }
  if (!rawSequence) return { conversationId };
  const [rawStart, rawEnd, ...extra] = rawSequence.split("-");
  if (extra.length > 0 || !rawStart) return null;
  const sequence = Number(rawStart);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) return null;
  if (rawEnd === undefined) return { conversationId, sequence };
  const endSequence = Number(rawEnd);
  if (!Number.isSafeInteger(endSequence) || endSequence < sequence) return null;
  return { conversationId, sequence, endSequence };
}

function ImportForm({ onImported }: { onImported: (value: Conversation) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [title, setTitle] = useState("");
  const [format, setFormat] = useState<ImportFormat>("txt");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setError("Transcript file must be at most 1 MB.");
      event.target.value = "";
      return;
    }
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (extension !== "vtt" && extension !== "srt" && extension !== "txt") {
      setError("Choose a VTT, SRT, or TXT transcript.");
      event.target.value = "";
      return;
    }
    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      setFormat(extension);
      setText(content);
      setFileName(file.name);
      if (!title.trim()) setTitle(file.name.replace(/\.[^.]+$/, ""));
      setError(null);
    } catch {
      setError("The transcript must be a valid UTF-8 text file.");
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || !title.trim() || !text.trim()) return;
    setPending(true);
    try {
      const imported = await rpc.call("transcripts.import", { title: title.trim(), format, text });
      setTitle(""); setText(""); setFileName(null); setError(null);
      onImported(imported);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3 rounded-lg border border-border bg-card p-4">
      <h2 className="font-semibold">Import a transcript</h2>
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <label className="space-y-1 text-sm"><span>Conversation title</span><Input aria-label="Conversation title" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} /></label>
        <label className="space-y-1 text-sm">
          <span>Format</span>
          <select aria-label="Transcript format" className="block h-9 rounded-md border border-input bg-background px-3 text-sm" value={format} onChange={(event) => setFormat(event.target.value as ImportFormat)}>
            <option value="txt">Plain text</option><option value="vtt">WebVTT</option><option value="srt">SRT</option>
          </select>
        </label>
      </div>
      <label className="block space-y-1 text-sm">
        <span>Transcript text</span>
        <textarea
          aria-label="Transcript text" placeholder="Paste transcript text here" value={text}
          className="min-h-32 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onChange={(event) => { setText(event.target.value); setFileName(null); }}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex h-9 cursor-pointer items-center rounded-md border border-input px-3 text-sm hover:bg-state-hover">
          Choose file
          <input className="sr-only" aria-label="Transcript file" type="file" accept=".vtt,.srt,.txt,text/plain,text/vtt" onChange={(event) => void chooseFile(event)} />
        </label>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{fileName ?? "UTF-8 VTT, SRT, or TXT · 1 MB maximum"}</span>
        <Button type="submit" disabled={pending || !title.trim() || !text.trim()}>{pending ? "Importing…" : "Import transcript"}</Button>
      </div>
      <ErrorMessage error={error} />
    </form>
  );
}

function SourceStatus() {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [status, setStatus] = useState<{
    zoom: { configured: boolean; enabled: boolean }; webhookPath: string; importReady: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("sources.status", null).then((value) => { setStatus(value); setError(null); }, (cause) => setError(errorText(cause)));
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useEffect(() => { const id = setInterval(refetch, 15_000); return () => clearInterval(id); }, [refetch]);
  useChangedSignal(refetch);
  return (
    <section aria-label="Source status" className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Sources</h2><span className="text-xs text-muted-foreground">Updates {connection}</span></div>
      <ErrorMessage error={error} />
      {status === null ? <p className="mt-2 text-sm text-muted-foreground">Checking sources…</p> : (
        <>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full bg-secondary px-2 py-1">{status.importReady ? "Import ready" : "Import unavailable"}</span>
            <span className="rounded-full bg-secondary px-2 py-1">{status.zoom.configured ? "Zoom configured" : "Zoom not configured"}</span>
            <span className="rounded-full bg-secondary px-2 py-1">{status.zoom.enabled ? "Zoom enabled" : "Zoom disabled"}</span>
          </div>
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Zoom setup details</summary>
            <div className="mt-2 space-y-1 rounded-md bg-muted p-3 text-muted-foreground">
              <p>Configure your Zoom app to send events to this webhook path:</p>
              <code className="block break-all text-xs text-foreground">{status.webhookPath}</code>
              <p>Zoom host controls govern the upstream transcription session.</p>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

function ConversationList({ conversations, open }: { conversations: Conversation[]; open: (id: string) => void }) {
  if (!conversations.length) return <StatusBox>No conversations yet. Import a transcript to begin.</StatusBox>;
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
      {conversations.map((item) => (
        <li key={item.id}><button type="button" className="w-full px-4 py-3 text-left hover:bg-state-hover" onClick={() => open(item.id)}>
          <div className="flex items-start justify-between gap-3"><span className="min-w-0 font-medium">{item.title}</span><span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-xs">{captureLabel(item.captureState)}</span></div>
          <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground"><span>{sourceLabel(item.sourceId)}</span><span>{item.segmentCount} passages</span><span>{freshness(item.lastReceivedAt)}</span></div>
          {item.interruptionCount > 0 ? <p className="mt-1 text-xs text-warning-foreground">Transcript may have gaps ({item.interruptionCount} interruptions)</p> : null}
        </button></li>
      ))}
    </ul>
  );
}

function CommunicationsPage({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const target = parseTarget(subPath);
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [current, setCurrent] = useState<Conversation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const refetch = useCallback(() => {
    rpc.call("conversations.list", { offset: 0, limit: 50 }).then(
      (value) => { setConversations(value.conversations); setError(null); },
      (cause) => setError(errorText(cause)),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useChangedSignal(refetch);

  if (subPath && target === null) return <div className="p-5"><ErrorMessage error="This conversation link is invalid." /></div>;
  if (target !== null) {
    const canStop = current !== null && ["connecting", "capturing", "paused"].includes(current.captureState);
    return <div className="h-full min-h-0 overflow-y-auto"><div className="mx-auto w-full max-w-3xl space-y-4 px-4 pb-6 pt-4 md:px-5">
      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => navigate.toPluginPanel("communications")}><Icon name="ChevronLeft" /> Conversations</Button>
        {canStop ? <Button type="button" variant="outline" size="sm" disabled={stopping} onClick={async () => {
          setStopping(true);
          try { setCurrent(await rpc.call("capture.stop", { conversationId: target.conversationId })); setError(null); }
          catch (cause) { setError(errorText(cause)); }
          finally { setStopping(false); }
        }}>{stopping ? "Stopping…" : "Stop local capture"}</Button> : null}
      </div>
      {canStop ? <p className="text-xs text-muted-foreground">This closes this hub’s connection. Zoom host controls govern the upstream session.</p> : null}
      <ErrorMessage error={error} />
      <TranscriptView
        conversationId={target.conversationId} initialSequence={target.sequence} initialEndSequence={target.endSequence}
        onPage={(page) => setCurrent(page.conversation)}
      />
    </div></div>;
  }
  return <div className="h-full min-h-0 overflow-y-auto"><div className="mx-auto w-full max-w-3xl space-y-5 px-4 pb-6 pt-4 md:px-5">
    <SourceStatus />
    <ImportForm onImported={(value) => { refetch(); navigate.toPluginPanel("communications", { subPath: value.id }); }} />
    <section aria-labelledby="recent-conversations" className="space-y-3">
      <h2 id="recent-conversations" className="font-semibold">Recent conversations</h2>
      <ErrorMessage error={error} />
      {conversations === null ? <StatusBox>Loading conversations…</StatusBox> : <ConversationList conversations={conversations} open={(id) => navigate.toPluginPanel("communications", { subPath: id })} />}
    </section>
  </div></div>;
}

/**
 * Quote a passage for the composer. The speaker name comes from the meeting
 * platform and is not identity: it is what the transcript claims, so the quote
 * says so rather than presenting it as an instruction from that person.
 */
function quoteBlock(block: SpeakerBlock, conversationTitle: string): string {
  const label = block.sequences.length === 1
    ? `passage ${block.firstSequence}`
    : `passages ${block.firstSequence}–${block.lastSequence}`;
  const who = block.speaker ?? "Unattributed speaker";
  const when = relativeTime(block.startMs);
  const heading = `From ${conversationTitle}, ${label} — ${who}${when ? ` at ${when}` : ""}:`;
  return `${heading}\n> ${block.text.replace(/\n/g, "\n> ")}`;
}

function ThreadConversationPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const composer = useComposer();
  const [attachment, setAttachment] = useState<ThreadAttachment | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(async () => {
    try {
      const [attached, listed] = await Promise.all([
        rpc.call("attachments.get", { threadId }),
        rpc.call("conversations.list", { offset: 0, limit: 100 }),
      ]);
      setAttachment(attached.attachment); setConversation(attached.conversation); setConversations(listed.conversations);
      setSelected((value) => value || attached.conversation?.id || listed.conversations[0]?.id || "");
      setError(null);
    } catch (cause) { setError(errorText(cause)); }
  }, [rpc, threadId]);
  useEffect(() => { void refetch(); }, [refetch]);
  const realtimeRefresh = useCallback(() => { void refetch(); }, [refetch]);
  useChangedSignal(realtimeRefresh);

  const attach = async () => {
    if (!selected) return;
    setPending(true);
    try {
      const next = await rpc.call("attachments.set", { threadId, conversationId: selected });
      setAttachment(next);
      setConversation(conversations.find(({ id }) => id === selected) ?? await rpc.call("conversations.get", { conversationId: selected }));
      setError(null);
    } catch (cause) { setError(errorText(cause)); }
    finally { setPending(false); }
  };

  return <div className="h-full min-h-0 overflow-y-auto p-4"><div className="space-y-4">
    <label className="block space-y-1 text-sm"><span>Choose conversation</span>
      <select aria-label="Choose conversation" className="block h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={selected} onChange={(event) => setSelected(event.target.value)}>
        {!conversations.length ? <option value="">No conversations available</option> : null}
        {conversations.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select>
    </label>
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" disabled={pending || !selected} onClick={() => void attach()}>{pending ? "Attaching…" : "Attach conversation"}</Button>
      {attachment ? <Button type="button" size="sm" variant="outline" disabled={pending} onClick={async () => {
        setPending(true);
        try { await rpc.call("attachments.detach", { threadId }); setAttachment(null); setConversation(null); setError(null); }
        catch (cause) { setError(errorText(cause)); }
        finally { setPending(false); }
      }}>Detach</Button> : null}
    </div>
    <ErrorMessage error={error} />
    {!attachment || !conversation ? <StatusBox>Attach this thread to a conversation to read its transcript.</StatusBox> : <>
      <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">Reading cursor: passage {attachment.cursor}. Reading and search do not acknowledge passages automatically.</div>
      <TranscriptView
        conversationId={conversation.id} compact
        onPage={(page) => setConversation(page.conversation)}
        onSend={(block) => {
          const quote = quoteBlock(block, conversation.title);
          composer.updateText((current) => current.trim().length === 0 ? quote : `${current.trimEnd()}\n\n${quote}`);
        }}
      />
    </>}
  </div></div>;
}

function ThreadConversationHeader({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [loaded, setLoaded] = useState(false);
  const refetch = useCallback(() => {
    rpc.call("attachments.get", { threadId }).then(
      (value) => { setConversation(value.conversation); setLoaded(true); },
      () => setLoaded(true),
    );
  }, [rpc, threadId]);
  useEffect(refetch, [refetch]);
  useChangedSignal(refetch);
  const accessible = conversation ? `Open attached conversation ${conversation.title}` : "Open conversation panel";
  return <Button
    type="button" variant="ghost" size={isCompactViewport ? "icon" : "sm"}
    className="h-7 max-w-56" aria-label={accessible} disabled={!loaded}
    onClick={() => navigate.openThreadPanel({ actionId: "conversation" })}
  >
    <Icon name="MessageSquare" />
    {isCompactViewport ? null : <span className="truncate">{conversation ? `${conversation.title} · ${captureLabel(conversation.captureState)}` : "No conversation attached"}</span>}
  </Button>;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "communications", title: "Communications", icon: "MessagesSquare",
    path: "communications", component: CommunicationsPage,
  });
  app.slots.threadPanelAction({
    id: "conversation", title: "Conversation", icon: "MessageSquare",
    component: ThreadConversationPanel, layout: "flush",
  });
  app.slots.experimental_threadHeaderAction({
    id: "conversation", title: "Conversation", component: ThreadConversationHeader,
  });
});
