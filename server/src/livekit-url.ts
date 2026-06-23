/**
 * Pick the HTTP base URL the sync server uses for its own RoomService calls
 * (kick). `livekitApiUrl` wins when set (self-hosted: http://localhost:7880);
 * otherwise fall back to the public signaling URL's HTTP form (LiveKit Cloud).
 * Returns undefined when neither is set (LiveKit not configured).
 */
export function resolveRoomServiceUrl(
	livekitUrl: string | undefined,
	livekitApiUrl: string | undefined,
): string | undefined {
	return livekitApiUrl ?? livekitUrl?.replace(/^ws/, 'http')
}
