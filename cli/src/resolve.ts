/**
 * The connection-resolution chain (spec §5.2): resolve the URL (flag → env →
 * default_instance), look up THAT url's file record, then overlay each env var
 * individually (the GH_TOKEN per-variable pattern — a lone ENSEMBLEWORKS_URL
 * keeps the file's creds/room). authHeaders emits the CF Access service-token
 * pair (exactly what gateway-go sends) only for a service-token instance.
 */
import { CliError } from './errors.ts'
import type { HostsFile } from './hosts.ts'

export interface Flags {
	url?: string
	room?: string
}

export interface Env {
	ENSEMBLEWORKS_URL?: string
	ENSEMBLEWORKS_ROOM?: string
	ENSEMBLEWORKS_TOKEN_ID?: string
	ENSEMBLEWORKS_TOKEN_SECRET?: string
}

export type Auth =
	| { method: 'service-token'; tokenId: string; tokenSecret: string }
	| { method: 'none' }

export interface Conn {
	url: string
	room: string
	auth: Auth
}

export function readEnv(env: NodeJS.ProcessEnv): Env {
	return {
		ENSEMBLEWORKS_URL: env.ENSEMBLEWORKS_URL,
		ENSEMBLEWORKS_ROOM: env.ENSEMBLEWORKS_ROOM,
		ENSEMBLEWORKS_TOKEN_ID: env.ENSEMBLEWORKS_TOKEN_ID,
		ENSEMBLEWORKS_TOKEN_SECRET: env.ENSEMBLEWORKS_TOKEN_SECRET,
	}
}

export function resolveConn(flags: Flags, env: Env, hosts: HostsFile): Conn {
	// 1. URL: flag → env → default_instance → error.
	const url = flags.url ?? env.ENSEMBLEWORKS_URL ?? hosts.default_instance
	if (!url) {
		throw new CliError(
			'no instance configured — pass --url, set ENSEMBLEWORKS_URL, or run `ensembleworks auth login`',
			2,
		)
	}

	// 2. The file record for THIS url (may be undefined for an env-only instance).
	const rec = hosts.instances[url]

	// 3. Per-variable overlay: a lone ENSEMBLEWORKS_URL keeps rec's creds/room.
	const room = flags.room ?? env.ENSEMBLEWORKS_ROOM ?? rec?.default_room ?? 'team'
	const tokenId = env.ENSEMBLEWORKS_TOKEN_ID ?? rec?.token_id
	const tokenSecret = env.ENSEMBLEWORKS_TOKEN_SECRET ?? rec?.token_secret

	const auth: Auth =
		tokenId && tokenSecret
			? { method: 'service-token', tokenId, tokenSecret }
			: { method: 'none' }

	return { url, room, auth }
}

export function authHeaders(auth: Auth): Record<string, string> {
	if (auth.method === 'service-token') {
		return {
			'CF-Access-Client-Id': auth.tokenId,
			'CF-Access-Client-Secret': auth.tokenSecret,
		}
	}
	return {}
}
