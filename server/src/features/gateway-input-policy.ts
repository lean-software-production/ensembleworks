/**
 * Owner-controlled input-policy toggle — POST /api/terminal/input-policy flips
 * a registered gateway between 'locked' (non-owner input dropped at the relay)
 * and 'shared' (the ensemble "hand over the keyboard" move). The FIRST
 * owner-match-or-403 endpoint: the caller's identity is resolved with the same
 * resolveGatewayOwner used at gateway registration, so the two strings compare
 * in the same sso:<email> / token:<common_name> format. Pure relay-plane
 * state — the connector is not involved (spec §4). Unlike the ctx-taking
 * feature routers, this one closes over the gateway registry (the policy's
 * single source of truth), which lives on the gateway plane, not in
 * PluginServerContext.
 */
import { terminalInputPolicy } from '@ensembleworks/contracts'
import express from 'express'
import type { GatewayRegistry } from '../gateway-registry.ts'
import { resolveGatewayOwner } from '../whoami.ts'

export function createGatewayInputPolicyRouter(registry: GatewayRegistry): express.Router {
	const router = express.Router()

	router.post(terminalInputPolicy.http.path, async (req, res) => {
		const body = (req.body ?? {}) as Record<string, unknown>
		const gatewayId = typeof body.gatewayId === 'string' && body.gatewayId ? body.gatewayId : null
		const policy = body.policy === 'locked' || body.policy === 'shared' ? body.policy : null
		if (!gatewayId) return void res.status(400).json({ error: 'gatewayId is required' })
		if (!policy) return void res.status(400).json({ error: 'policy must be locked | shared' })
		const entry = registry.get(gatewayId)
		if (!entry) return void res.status(404).json({ error: `unknown gateway: ${gatewayId}` })
		const caller = await resolveGatewayOwner(req.headers).catch(() => null)
		if (caller === null || caller !== entry.ownerIdentity) {
			return void res.status(403).json({ error: 'only the gateway owner may change its input policy' })
		}
		registry.setInputPolicy(gatewayId, policy)
		res.json({ ok: true, gatewayId, policy })
	})

	return router
}
