# Canonical domain glossary

| Term | Definition |
| --- | --- |
| Communications hub | The application-level service owning conversations, transcript storage, search, and capture status for one BB instance. |
| Source adapter | Code translating an external input into the hub's transcript format. Platform-specific behaviour belongs here. |
| Source connection | A configured input using a source adapter. Supported inputs include file import, Zoom, the EnsembleWorks V1 transcript endpoint, and the local BB Canvas transcript feed. |
| Space | An ongoing place where communication happens, such as a channel or recurring meeting series. Future adapters can group conversations under a space. |
| Conversation | A bounded context that a BB thread attaches to: a meeting occurrence, an imported transcript, or a future channel time window. It has a hub-owned ID independent of its source. |
| Meeting | A synchronous conversation occurrence. It is a kind of conversation, not the hub’s generic term. |
| Conversation entry | A generic unit of communication, such as a chat message or transcript segment. The MVP implements transcript segments; future chat adapters must preserve message IDs, edits, replies, and provenance. |
| Transcript segment | An immutable passage with a stable ID, ingestion sequence, text, provenance, and available speaker and timing information. |
| Passage | One transcript segment as presented to a reader. Search results are passages; they are never joined. |
| Speaker block | A read-time view joining one speaker's consecutive passages into a single run. It may continue across another speaker's interjection, so its member sequences need not be contiguous. Grouping never changes stored segments. |
| Citation | A reference to a passage or a block, written as an ingestion sequence ("7") or a range ("7-9"). A range addresses the span between its endpoints, not a contiguous run by one speaker; a block's member sequences are its precise membership. |
| Thread attachment | A thread's reference to one conversation and its own reading position. Detaching does not stop capture or delete the conversation. |
| Capture | Receiving live transcription into the hub. It belongs to the hub, not a thread or agent session. |
| Capture state | Whether capture is connecting, capturing, paused, stopped, interrupted, or ended; idle means no live capture (such as an import). |
| Reading cursor | A per-thread acknowledged ingestion sequence. Reading/searching does not advance it implicitly. |
| Source key | Adapter-provided identity used to deduplicate retransmitted segments within a conversation. |
| Provenance | The source connection, external occurrence identity, and source key explaining where a segment came from. |

Use “conversation” in the UI. “Current conversation” resolves the current thread attachment; it is not global hub state. “Conversation context” means retrieved information, not another stored entity. Timestamps in transcript segments are source-relative milliseconds (file start, or the Zoom adapter’s first capture anchor) or null when unknown; receipt times are Unix milliseconds. The ingestion sequence, not speech time, orders cursor reads so late packets remain discoverable. Speaker blocks are presentation only: pages are still bounded by stored segments, and every member sequence of a block remains individually citable.

## Spaces and time windows

The MVP implements conversation attachments and transcript segments. Space subscriptions, Slack/Discord connections, and automatic daily windows are future work. A calendar day is a view/window of a space in its explicitly selected IANA timezone, not a reason to discard reply relationships or split stored messages irreversibly. Do not add channel APIs until an adapter needs them. Keep window membership based on event time and reading cursors based on ingestion sequence.

**Known interruptions** count pauses, local stops, transport failures, and restarts observed during capture. They indicate possible gaps; zero is not proof of complete capture. Zoom speech timing is relative to first capture, which can start after the meeting.

## Canvas source adapter

Canvas capture is an explicitly started conversation, bounded by a local stop. It initially imports the retained transcript and then follows new entries. It does not infer meeting boundaries, create rooms, or subscribe threads automatically. A new capture after stopping reimports retained history into a separate conversation. The source insertion ID is the checkpoint; speech timestamps never determine ingestion order. Timing is relative to the first imported utterance, with earlier late arrivals marked unknown. The existing source provides speaker labels but no participant IDs or utterance end times; these remain unknown. Capturing means the transcript store is reachable, not that upstream audio transcription is healthy.

The EnsembleWorks V1 source adapter also uses explicitly started/stopped conversations. It starts from now unless an earlier Unix-millisecond bound is supplied. Its source key is the original utterance ID; its progress checkpoint is a timestamp with a 60-second reread overlap, reflecting the limitations of the existing V1 API. Unlike the BB Canvas feed, it preserves LiveKit participant identity. Neither adapter changes thread attachments automatically.
