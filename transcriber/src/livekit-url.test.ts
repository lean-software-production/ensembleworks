// Tests for the scribe connect-URL resolver. Run with: bun src/livekit-url.test.ts
import assert from 'node:assert/strict'
import { resolveScribeConnectUrl } from './livekit-url.ts'

// LiveKit Cloud default: no LIVEKIT_URL in scribe.env -> use the URL the token
// endpoint returned. This is the regression-guard case — pre-cutover behavior
// is unchanged.
{
	const got = resolveScribeConnectUrl('wss://x/livekit', undefined)
	assert.equal(got, 'wss://x/livekit', 'Cloud default returns endpoint url')
	console.log('ok: Cloud default (endpoint url)')
}

// Self-host override: scribe.env LIVEKIT_URL wins (ws://localhost:7880).
{
	const got = resolveScribeConnectUrl('wss://x/livekit', 'ws://localhost:7880')
	assert.equal(got, 'ws://localhost:7880', 'env url wins over endpoint url')
	console.log('ok: self-host override wins')
}

// Env url alone (endpoint returned nothing usable) — still resolves.
{
	const got = resolveScribeConnectUrl(undefined, 'ws://localhost:7880')
	assert.equal(got, 'ws://localhost:7880', 'env url alone is fine')
	console.log('ok: env url alone resolves')
}

// Neither set -> undefined (fetchToken's caller treats this as not-configured).
{
	const got = resolveScribeConnectUrl(undefined, undefined)
	assert.equal(got, undefined, 'neither set -> undefined')
	console.log('ok: neither set -> undefined')
}

console.log('livekit-url.test.ts: all tests passed')
