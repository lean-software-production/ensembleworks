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
});
export type Conversation = z.infer<typeof conversationSchema>;
export const segmentSchema = z.object({
  id: z.string(), conversationId: z.string(), sequence: z.number(), sourceKey: z.string(),
  speaker: z.string().nullable(), speakerId: z.string().nullable(), text: z.string(), startMs: z.number().nullable(), endMs: z.number().nullable(), receivedAt: z.number(),
});
export type TranscriptSegment = z.infer<typeof segmentSchema>;
export const attachmentSchema = z.object({threadId: z.string(), conversationId: z.string(), cursor: z.number()});
export type ThreadAttachment = z.infer<typeof attachmentSchema>;
/** Source adapters depend on this interface, not BB threads or the concrete hub. */
export interface TranscriptSink {
  ensureConversation(sourceId: string, externalId: string, title: string): {id: string};
  appendSegments(conversationId: string, segments: SegmentInput[]): unknown;
  setCapture(conversationId: string, state: CaptureState, detail?: string | null): unknown;
}
