/**
 * Pick the WebSocket URL the scribe connects its Room to. `envUrl` wins when set
 * (self-hosted: ws://localhost:7880, co-located with the SFU); otherwise fall
 * back to the URL the token endpoint returned (LiveKit Cloud).
 */
export function resolveScribeConnectUrl(
	tokenEndpointUrl: string | undefined,
	envUrl: string | undefined,
): string | undefined {
	return envUrl ?? tokenEndpointUrl
}
