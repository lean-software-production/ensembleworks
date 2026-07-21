/**
 * Pure view derivation for codespace gateways (SP3). Live state (status/
 * owner/inputPolicy) is NEVER stored in synced shape props — the gateway
 * registry is the single source of truth and clients poll
 * GET /api/terminal/list (decision log 2026-07-21, SP3 item 2). This module
 * is the pure half: bun-testable, no DOM, no fetch. The relay drops locked
 * non-owner input server-side regardless — everything here is decoration.
 */

/** One entry of GET /api/terminal/list. repo/branch/inputPolicy/owner/
 * viewerIsOwner are the SP3 fields; optional so a client deployed ahead of
 * the server degrades gracefully. */
export interface GatewayListEntry {
	gatewayId: string
	label: string
	connectedAt: number
	repo?: string
	branch?: string
	inputPolicy?: 'locked' | 'shared'
	owner?: string
	viewerIsOwner?: boolean
}

export interface CodespaceView {
	/** 'unknown' until the first poll lands; then connected/offline. */
	status: 'unknown' | 'connected' | 'offline'
	owner: string | null
	/** Absent policy reads locked — the safe direction. */
	inputPolicy: 'locked' | 'shared'
	viewerIsOwner: boolean
}

export function codespaceViewFor(
	gateways: GatewayListEntry[] | null,
	gatewayId: string
): CodespaceView {
	if (gateways === null) {
		return { status: 'unknown', owner: null, inputPolicy: 'locked', viewerIsOwner: false }
	}
	const gw = gateways.find((g) => g.gatewayId === gatewayId)
	if (!gw) return { status: 'offline', owner: null, inputPolicy: 'locked', viewerIsOwner: false }
	return {
		status: 'connected',
		owner: gw.owner ?? null,
		inputPolicy: gw.inputPolicy ?? 'locked',
		viewerIsOwner: gw.viewerIsOwner === true,
	}
}

/** Local stdin gate + read-only badge decision. Only a CONNECTED locked
 * gateway gates: 'unknown' must not lock the keyboard on a guess, and an
 * offline gateway's input goes nowhere anyway (the ws is down). The server
 * remains the authority either way. */
export function inputLockedForViewer(view: CodespaceView): boolean {
	return view.status === 'connected' && view.inputPolicy === 'locked' && !view.viewerIsOwner
}
