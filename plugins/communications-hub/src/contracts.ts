import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { attachmentSchema, conversationSchema, registrantSchema, roomSchema, segmentSchema } from './domain';
import { importFormatSchema } from './adapters/import';

export const id=z.string().trim().min(1).max(256);
const page=z.object({conversation:conversationSchema,segments:z.array(segmentSchema),hasMore:z.boolean(),nextCursor:z.number()});
export const readInput=z.object({conversationId:id,after:z.number().int().nonnegative().optional(),limit:z.number().int().min(1).max(30).optional(),fromMs:z.number().int().nonnegative().optional(),toMs:z.number().int().nonnegative().optional()}).strict();
export const importInput=z.object({title:z.string().trim().min(1).max(200),format:importFormatSchema,text:z.string().min(1).max(1_000_000)}).strict();
export const rpcContract=defineRpcContract({
  'conversations.list':{input:z.object({offset:z.number().int().nonnegative().optional(),limit:z.number().int().min(1).max(100).optional()}).strict(),output:z.object({conversations:z.array(conversationSchema),hasMore:z.boolean(),nextOffset:z.number()})},
  'conversations.get':{input:z.object({conversationId:id}).strict(),output:conversationSchema},
  'conversations.rename':{input:z.object({conversationId:id,title:z.string().trim().min(1).max(200)}).strict(),output:conversationSchema},
  'transcripts.import':{input:importInput,output:conversationSchema},
  'transcripts.read':{input:readInput,output:page},
  'transcripts.search':{input:readInput.extend({query:z.string().trim().min(1).max(200)}),output:page},
  'attachments.get':{input:z.object({threadId:id}).strict(),output:z.object({attachment:attachmentSchema.nullable(),conversation:conversationSchema.nullable(),room:roomSchema.nullable()})},
  'attachments.set':{input:z.object({threadId:id,conversationId:id}).strict(),output:attachmentSchema},
  'attachments.setRoom':{input:z.object({threadId:id,roomId:id}).strict(),output:attachmentSchema},
  'attachments.detach':{input:z.object({threadId:id}).strict(),output:z.object({ok:z.boolean()})},
  'attachments.acknowledge':{input:z.object({threadId:id,conversationId:id,cursor:z.number().int().nonnegative()}).strict(),output:attachmentSchema},
  'rooms.list':{input:z.object({includeArchived:z.boolean().optional()}).strict(),output:z.object({rooms:z.array(roomSchema)})},
  'rooms.create':{input:z.object({name:z.string().trim().min(1).max(200)}).strict(),output:roomSchema},
  'rooms.archive':{input:z.object({roomId:id}).strict(),output:roomSchema},
  'rooms.renew':{input:z.object({roomId:id}).strict(),output:roomSchema},
  'rooms.delete':{input:z.object({roomId:id}).strict(),output:roomSchema},
  'registrants.list':{input:z.object({roomId:id}).strict(),output:z.object({registrants:z.array(registrantSchema)})},
  'registrants.add':{input:z.object({roomId:id,name:z.string().trim().min(1).max(200),email:z.string().trim().min(3).max(320)}).strict(),output:registrantSchema},
  'capture.stop':{input:z.object({conversationId:id}).strict(),output:conversationSchema},
  'sources.status':{input:z.null(),output:z.object({zoom:z.object({configured:z.boolean(),enabled:z.boolean(),canCreateRooms:z.boolean()}),webhookPath:z.string(),importReady:z.boolean()})},
});
