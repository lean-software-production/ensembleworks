// server/src/features/tools.ts
// Kernel meta-route: GET /api/tools serves the tool manifest — the JSON-Schema
// projection of the contracts tool registry. Read-only; static for the process
// lifetime (the registry never changes at runtime). See slice 3b spec.
import { allTools, buildManifest } from '@ensembleworks/contracts'
import express from 'express'
import { SERVER_VERSION } from '../version.ts'

export function createToolsRouter(): express.Router {
	const router = express.Router()
	// Precompute once — the manifest is static for the process lifetime.
	const manifest = buildManifest(allTools, SERVER_VERSION)
	router.get('/api/tools', (_req, res) => res.json(manifest))
	return router
}
