/**
 * The identity envelope shared by the server's GET /api/whoami and (later) the
 * CLI's `auth status`. Pure type + schema — browser-safe, exported from the
 * barrel. See docs/unified-architecture-design.md §6.4.
 */
import { z } from 'zod'

export type WhoamiKind = 'human' | 'bot' | 'anonymous'
export type WhoamiVia = 'sso' | 'service-token' | 'none'

export interface Whoami {
	identity: string | null
	kind: WhoamiKind
	via: WhoamiVia
}

export const whoamiSchema = z.object({
	identity: z.string().nullable(),
	kind: z.enum(['human', 'bot', 'anonymous']),
	via: z.enum(['sso', 'service-token', 'none']),
})
