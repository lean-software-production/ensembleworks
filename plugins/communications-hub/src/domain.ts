import { z } from "zod";

export const captureStateSchema = z.enum(["idle", "connecting", "capturing", "paused", "stopped", "interrupted", "ended"]);
export type CaptureState = z.infer<typeof captureStateSchema>;
export const segmentInputSchema = z.object({
  sourceKey: z.string().min(1).max(256), speaker: z.string().max(200).nullable(),
  /** Source-assigned participant identity, stable for one capture. Distinguishes same-named speakers. */
  speakerId: z.string().max(200).nullable().optional(),
  text: z.string().min(1).max(2000).refine(value => value.trim().length > 0, "Text is empty"),
  startMs: z.number().int().nonnegative().nullable(), endMs: z.number().int().nonnegative().nullable(),
}).strict().refine(s => s.startMs === null || s.endMs === null || s.endMs >= s.startMs, "End time precedes start time");
export type SegmentInput = z.infer<typeof segmentInputSchema>;
export const conversationSchema = z.object({
  id: z.string(), title: z.string(), sourceId: z.string(), externalId: z.string(),
  createdAt: z.number(), captureStartedAt: z.number().nullable(), lastReceivedAt: z.number().nullable(),
  /** When capture last left an active state. With captureStartedAt this bounds the billed stream window. */
  captureEndedAt: z.number().nullable(),
  captureState: captureStateSchema, captureDetail: z.string().nullable(), interruptionCount: z.number(), segmentCount: z.number(),
  /** The room this capture happened in, when it happened in one. Imports never belong to a room. */
  roomId: z.string().nullable(),
});
export type Conversation = z.infer<typeof conversationSchema>;
/**
 * A reusable meeting that BB created and owns.
 *
 * A Zoom meeting id is stable while `meeting_uuid` changes per occupancy period, so one room
 * accumulates many conversations. The room is the durable thing a team refers to; a
 * conversation is one sitting in it.
 */
export const roomSchema = z.object({
  id: z.string(), name: z.string(), sourceId: z.string(),
  externalId: z.string(), joinUrl: z.string(), hostUser: z.string(),
  createdAt: z.number(), archivedAt: z.number().nullable(),
  /** When the source recurrence runs out. A room stops working on this date unless renewed. */
  expiresAt: z.number().nullable(),
  /** When the meeting was deleted at the source. Its join URLs stopped working then. */
  sourceDeletedAt: z.number().nullable(),
});
export type Room = z.infer<typeof roomSchema>;
/**
 * A person BB registered for a room, and the personal join URL Zoom issued them.
 *
 * The registered name is what appears in the participant list, so it is the only link between
 * a transcript segment and a BB identity. RTMS never reports the registrant or their email.
 */
export const registrantSchema = z.object({
  id: z.string(), roomId: z.string(), name: z.string(), email: z.string(),
  externalId: z.string(), joinUrl: z.string(), createdAt: z.number(),
});
export type Registrant = z.infer<typeof registrantSchema>;
export const segmentSchema = z.object({
  id: z.string(), conversationId: z.string(), sequence: z.number(), sourceKey: z.string(),
  speaker: z.string().nullable(), speakerId: z.string().nullable(), text: z.string(), startMs: z.number().nullable(), endMs: z.number().nullable(), receivedAt: z.number(),
});
export type TranscriptSegment = z.infer<typeof segmentSchema>;
export const attachmentSchema = z.object({
  threadId: z.string(),
  /** Set when the thread follows a room rather than one sitting in it. */
  roomId: z.string().nullable(),
  /** The sitting currently being read. Null only for a room nobody has met in yet. */
  conversationId: z.string().nullable(),
  cursor: z.number(),
});
export type ThreadAttachment = z.infer<typeof attachmentSchema>;
/** Source adapters depend on this interface, not BB threads or the concrete hub. */
export interface TranscriptSink {
  ensureConversation(sourceId: string, externalId: string, title: string): {id: string};
  appendSegments(conversationId: string, segments: SegmentInput[]): unknown;
  setCapture(conversationId: string, state: CaptureState, detail?: string | null): unknown;
  /** Rooms the adapter created earlier, looked up by the identifier the source reports. */
  findRoom(sourceId: string, externalId: string): Room | null;
  getRoom(roomId: string): Room;
  createRegistrant(input: {roomId: string; name: string; email: string; externalId: string; joinUrl: string}): Registrant;
  setRoomExpiry(roomId: string, expiresAt: number): Room;
  markRoomDeleted(roomId: string): Room;
  createRoom(input: {name: string; sourceId: string; externalId: string; joinUrl: string; hostUser: string; expiresAt?: number | null}): Room;
  setConversationRoom(conversationId: string, roomId: string): unknown;
  /** Replace a generated title, but only while it is still the generated one. */
  renameIfUnchanged(conversationId: string, expected: string, title: string): unknown;
}
