/**
 * ~/.config/ensembleworks/codespaces.json (decision #6): a map keyed by the
 * REALPATH of the checkout → { gatewayId, containerId?, repo, branch,
 * canvasUrl }. gatewayId = cs-<dirname>-<first 8 hex of sha256(realpath)> —
 * stable across reboots (the shape reattaches instead of duplicating, design
 * §2.1), distinct across clones. No secrets → plain 0644 JSON (contrast
 * hosts.toml); mkdir -p + round-trip only. Grows into SP4's desired-state.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface CodespaceRecord {
	gatewayId: string
	containerId?: string
	repo: string
	branch: string
	canvasUrl: string
	/** SP4 desired-state (decision #1): what the reconciler drives toward.
	 *  Absent = not reconciler-managed (pre-SP4 record; next live `up` claims it). */
	desired?: 'up' | 'stopped'
}

export interface CodespacesFile {
	codespaces: Record<string, CodespaceRecord>
}

export function codespacesPath(env: NodeJS.ProcessEnv = process.env): string {
	const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
	return path.join(configHome, 'ensembleworks', 'codespaces.json')
}

export function loadCodespaces(file: string): CodespacesFile {
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8')) as { codespaces?: unknown }
		return { codespaces: (parsed.codespaces ?? {}) as Record<string, CodespaceRecord> }
	} catch {
		return { codespaces: {} } // absent (or corrupt — we mint fresh) file is fine
	}
}

export function saveCodespaces(file: string, data: CodespacesFile): void {
	mkdirSync(path.dirname(file), { recursive: true })
	writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
}

/** cs-<dirname>-<hash8 of realpath> — decision #6's exact recipe. */
export function mintGatewayId(realpathOfCheckout: string): string {
	const hash8 = createHash('sha256').update(realpathOfCheckout).digest('hex').slice(0, 8)
	return `cs-${path.basename(realpathOfCheckout)}-${hash8}`
}

/** Existing record wins (stable gatewayId + containerId survive re-ups; the
 *  repo/branch/canvasUrl metadata refreshes); else mint and persist. */
export function ensureCodespaceRecord(
	file: string,
	realpathOfCheckout: string,
	info: { repo: string; branch: string; canvasUrl: string },
): CodespaceRecord {
	const store = loadCodespaces(file)
	const existing = store.codespaces[realpathOfCheckout]
	const rec: CodespaceRecord = existing
		? { ...existing, repo: info.repo, branch: info.branch, canvasUrl: info.canvasUrl }
		: { gatewayId: mintGatewayId(realpathOfCheckout), ...info }
	saveCodespaces(file, { codespaces: { ...store.codespaces, [realpathOfCheckout]: rec } })
	return rec
}

export function updateContainerId(file: string, realpathOfCheckout: string, containerId: string): void {
	const store = loadCodespaces(file)
	const rec = store.codespaces[realpathOfCheckout]
	if (!rec) return
	saveCodespaces(file, { codespaces: { ...store.codespaces, [realpathOfCheckout]: { ...rec, containerId } } })
}

/** Flip the reconciler's desired-state for a checkout. Set ONLY by the live
 *  `up`/`stop` engines — dry-run and plan paths never mutate desired. */
export function setDesired(file: string, realpathOfCheckout: string, desired: 'up' | 'stopped'): void {
	const store = loadCodespaces(file)
	const rec = store.codespaces[realpathOfCheckout]
	if (!rec) return
	saveCodespaces(file, { codespaces: { ...store.codespaces, [realpathOfCheckout]: { ...rec, desired } } })
}
