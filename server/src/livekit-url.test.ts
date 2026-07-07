// Tests for the RoomService URL resolver. Run with: bun src/livekit-url.test.ts
import assert from 'node:assert/strict'
import { resolveRoomServiceUrl } from './livekit-url.ts'

// LiveKit Cloud default: no LIVEKIT_API_URL set -> derive the HTTP base from
// the public signaling URL. NOTE: the original code was `url.replace(/^ws/,
// 'http')`, so `wss://` -> `https://` (the trailing `s` survives) — that's
// correct and desired (LiveKit Cloud wss signaling -> https RoomService). This
// is the regression-guard case — it MUST stay non-undefined so /api/av/kick keeps
// working pre-cutover.
{
	const got = resolveRoomServiceUrl('wss://x/livekit', undefined)
	assert.equal(got, 'https://x/livekit', 'Cloud default derives https from wss')
	console.log('ok: Cloud default (wss -> https, non-undefined)')
}

// Self-host override: LIVEKIT_API_URL wins (http://localhost:7880).
{
	const got = resolveRoomServiceUrl('wss://x/livekit', 'http://localhost:7880')
	assert.equal(got, 'http://localhost:7880', 'explicit API URL wins')
	console.log('ok: self-host override wins')
}

// LiveKit not configured: neither set -> undefined (liveKitRoomService stays null).
{
	const got = resolveRoomServiceUrl(undefined, undefined)
	assert.equal(got, undefined, 'neither set -> undefined')
	console.log('ok: neither set -> undefined')
}

// Edge: public URL unset but API URL set (unusual, but resolve cleanly).
{
	const got = resolveRoomServiceUrl(undefined, 'http://localhost:7880')
	assert.equal(got, 'http://localhost:7880', 'api url alone is fine')
	console.log('ok: api url alone resolves')
}

// The self-host internal URL is plain ws:// (scribe) or http:// (server) to
// localhost; confirm the fallback does NOT mangle a ws:// public URL into
// httpss:// the way a naive replace could. (Sanity for the replace regex.)
{
	const got = resolveRoomServiceUrl('ws://localhost:7880', undefined)
	assert.equal(got, 'http://localhost:7880', 'ws:// -> http:// (no double-s)')
	console.log('ok: ws:// -> http:// (regex sanity)')
}

console.log('livekit-url.test.ts: all tests passed')
