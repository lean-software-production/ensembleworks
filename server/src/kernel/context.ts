/**
 * PluginServerContext — the capability surface feature routers receive
 * instead of reaching into app.ts closures (unified design §1.3, Phase-2
 * scope: only capabilities that exist today).
 */
import type express from 'express'
import type { createRoadmapStore } from '../roadmap-store.ts'
import type { createTelemetryStore } from '../telemetry-store.ts'
import type { createTranscriptStore } from '../transcript-store.ts'
import type { MediaService } from './media.ts'
import type { RoomHost } from './rooms.ts'
import type { SessionRegistry } from './sessions.ts'

export interface PluginServerContext {
	rooms: RoomHost
	sessions: SessionRegistry
	media: MediaService
	storage: {
		transcripts: ReturnType<typeof createTranscriptStore>
		roadmaps: ReturnType<typeof createRoadmapStore>
		telemetry: ReturnType<typeof createTelemetryStore>
		uploadsDir: string
	}
}

export type FeatureRouter = (ctx: PluginServerContext) => express.Router
