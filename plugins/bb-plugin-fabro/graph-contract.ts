import { z } from 'zod';

export const graphSchema = z.object({
  svg: z.string().min(1).max(512_000),
  stages: z.array(z.object({
    node_id: z.string().max(200), name: z.string().max(500),
    status: z.string().max(100), visit: z.number().int().min(0),
  })).max(1000),
  stagesComplete: z.boolean(),
});
export type RunGraph = z.infer<typeof graphSchema>;
