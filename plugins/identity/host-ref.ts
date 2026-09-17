import { z } from "zod";

/** A machine, as little of it as this plugin needs. Lives apart from hosts.ts so
 * attribution can record one without importing the host-mapping module. */
export const hostRefSchema = z.object({ id: z.string(), name: z.string() }).strict();
export type HostRef = z.infer<typeof hostRefSchema>;
