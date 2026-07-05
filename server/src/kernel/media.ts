/**
 * MediaService — LiveKit credentials/config + RoomServiceClient. Config is
 * captured at construction (inside createSyncApp), NOT at module import:
 * this removes the env-before-import ordering that scribe-api.test.ts
 * previously had to work around with a dynamic import. Config is captured
 * per-construction, so two createSyncApp() instances in one process can
 * differ if env changes between them.
 */
import { RoomServiceClient } from 'livekit-server-sdk'
import { resolveRoomServiceUrl } from '../livekit-url.ts'

export interface MediaService {
	apiKey: string | undefined
	apiSecret: string | undefined
	url: string | undefined
	roomService: RoomServiceClient | null
}

export function createMediaService(env: NodeJS.ProcessEnv = process.env): MediaService {
	// LiveKit token endpoint configuration. The tldraw presence userId is used as
	// the LiveKit participant identity, which is how the client matches video
	// bubbles to cursors. When LiveKit isn't configured the client hides all A/V UI.
	const apiKey = env.LIVEKIT_API_KEY
	const apiSecret = env.LIVEKIT_API_SECRET
	// Public signaling URL returned to browser clients (wss://…/livekit via tunnel).
	const url = env.LIVEKIT_URL
	// Internal HTTP base for the server's own RoomService calls (kick). Co-located
	// with livekit-server -> hit localhost and skip the tunnel + CF Access round
	// trip. Defaults to the public URL's HTTP form for LiveKit Cloud.
	const apiUrl = env.LIVEKIT_API_URL
	// Guard on the RESOLVED url, not on LIVEKIT_API_URL directly — otherwise
	// pre-cutover (LiveKit Cloud, no LIVEKIT_API_URL) roomService would be
	// null and /api/kick's removeParticipant would silently stop working.
	const roomServiceUrl = resolveRoomServiceUrl(url, apiUrl)
	const roomService =
		apiKey && apiSecret && roomServiceUrl ? new RoomServiceClient(roomServiceUrl, apiKey, apiSecret) : null

	return { apiKey, apiSecret, url, roomService }
}
