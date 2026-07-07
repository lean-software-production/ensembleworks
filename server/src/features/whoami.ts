/**
 * Auth-plane foundation route: GET /api/whoami returns the caller's identity
 * envelope (human|bot|anonymous + via) via resolveCaller. A kernel/auth route —
 * deliberately not plugin-namespaced, and untouched by the sub-project 3a route
 * rename.
 */
import { kernelWhoami } from '@ensembleworks/contracts'
import express from 'express'
import { resolveCaller } from '../whoami.ts'

export function createWhoamiRouter(): express.Router {
	const router = express.Router()
	router.get(kernelWhoami.http.path, async (req, res) => {
		res.json(await resolveCaller(req.headers))
	})
	return router
}
