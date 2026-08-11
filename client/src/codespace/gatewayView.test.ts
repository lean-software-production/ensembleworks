// Pure view derivation for codespace gateways (SP3): list poll → status dot /
// owner / policy / read-only decision. Server-side enforcement is the
// authority; this drives DECORATION (badge, local stdin gate).
// Run with: bun src/codespace/gatewayView.test.ts
import assert from 'node:assert/strict'
import { codespaceViewFor, inputLockedForViewer, type GatewayListEntry } from './gatewayView'

const cs: GatewayListEntry = {
	gatewayId: 'cs1',
	label: 'CS',
	connectedAt: 1,
	repo: 'github.com/acme/app',
	branch: 'main',
	inputPolicy: 'locked',
	owner: 'sso:owner@acme.dev',
	viewerIsOwner: false,
}

// Poll not landed yet → unknown; never locks the keyboard on a guess.
{
	const view = codespaceViewFor(null, 'cs1')
	assert.equal(view.status, 'unknown')
	assert.equal(inputLockedForViewer(view), false, 'unknown status never gates input')
}

// Gateway absent from the list → offline; input goes nowhere anyway, not gated.
{
	const view = codespaceViewFor([], 'cs1')
	assert.equal(view.status, 'offline')
	assert.equal(view.owner, null)
	assert.equal(inputLockedForViewer(view), false, 'offline gateway not gated (ws is down regardless)')
}

// Connected + locked + non-owner → read-only.
{
	const view = codespaceViewFor([cs], 'cs1')
	assert.equal(view.status, 'connected')
	assert.equal(view.owner, 'sso:owner@acme.dev')
	assert.equal(view.inputPolicy, 'locked')
	assert.equal(view.viewerIsOwner, false)
	assert.equal(inputLockedForViewer(view), true, 'locked + non-owner → read-only')
}

// Owner is never gated; shared is never gated.
assert.equal(inputLockedForViewer(codespaceViewFor([{ ...cs, viewerIsOwner: true }], 'cs1')), false)
assert.equal(inputLockedForViewer(codespaceViewFor([{ ...cs, inputPolicy: 'shared' }], 'cs1')), false)

// Pre-SP3 servers (fields absent): default policy reads locked — the safe
// direction — but the connected+locked gate still needs an explicit policy
// only; owner/viewerIsOwner default falsy.
{
	const bare: GatewayListEntry = { gatewayId: 'plain1', label: 'Box', connectedAt: 1 }
	const view = codespaceViewFor([bare], 'plain1')
	assert.equal(view.status, 'connected')
	assert.equal(view.inputPolicy, 'locked', 'absent policy defaults locked (safe direction)')
	assert.equal(view.viewerIsOwner, false)
}

console.log('ok: codespaceViewFor + inputLockedForViewer — status/policy/read-only matrix')
