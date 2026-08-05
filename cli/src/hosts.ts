/**
 * The hosts.toml store (~/.config/ensembleworks/hosts.toml): an AUTH-ONLY file
 * (no gateway identity) of `default_instance` + `[instances."<url>"]` records.
 * Written 0600; every read stats it and warns (never blocks) on group/world
 * bits — the gh/ssh habit. smol-toml round-trips the quoted-URL table keys.
 */
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse, stringify } from 'smol-toml'

export interface InstanceRecord {
	method: 'service-token' | 'none' | 'access-browser'
	token_id?: string
	token_secret?: string
	/** access-browser (SP5): the long-lived Access org token — THE stored credential */
	org_token?: string
	/** access-browser: cached short-lived app token; re-minted from org_token when stale */
	app_token?: string
	/** access-browser: <team>.cloudflareaccess.com host, discovered from the probe redirect */
	team_domain?: string
	/** access-browser: the Access application AUD tag (the login redirect's kid param) */
	aud?: string
	default_room?: string
	identity?: string
}

export interface HostsFile {
	default_instance?: string
	instances: Record<string, InstanceRecord>
}

/** Real-FS config path (never import.meta-relative — compile-safe, §9.2). */
export function hostsPath(env: NodeJS.ProcessEnv = process.env): string {
	const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
	return path.join(configHome, 'ensembleworks', 'hosts.toml')
}

export function loadHosts(file: string): HostsFile {
	let raw: string
	try {
		raw = readFileSync(file, 'utf8')
	} catch {
		return { instances: {} } // absent file is fine — a fully env-driven agent needs none
	}
	warnOnLoosePerms(file)
	const parsed = parse(raw) as { default_instance?: unknown; instances?: unknown }
	return {
		default_instance: typeof parsed.default_instance === 'string' ? parsed.default_instance : undefined,
		instances: (parsed.instances ?? {}) as Record<string, InstanceRecord>,
	}
}

export function saveHosts(file: string, hosts: HostsFile): void {
	mkdirSync(path.dirname(file), { recursive: true })
	const doc: Record<string, unknown> = {}
	if (hosts.default_instance) doc.default_instance = hosts.default_instance
	doc.instances = hosts.instances
	writeFileSync(file, stringify(doc), { mode: 0o600 })
	chmodSync(file, 0o600) // writeFileSync mode is masked by umask; force 0600 (headless boxes, §5.1)
}

/** Set (or replace) an instance record and make it the default (last login wins). */
export function setInstance(hosts: HostsFile, url: string, rec: InstanceRecord): HostsFile {
	return { default_instance: url, instances: { ...hosts.instances, [url]: rec } }
}

/** Remove an instance; if it was the default, reassign to the first survivor or clear. */
export function removeInstance(hosts: HostsFile, url: string): HostsFile {
	const instances = { ...hosts.instances }
	delete instances[url]
	let default_instance = hosts.default_instance
	if (default_instance === url) default_instance = Object.keys(instances)[0]
	return { default_instance, instances }
}

function warnOnLoosePerms(file: string): void {
	try {
		const mode = statSync(file).mode & 0o777
		if (mode & 0o077) {
			process.stderr.write(
				`warning: ${file} has permissions 0${mode.toString(8).padStart(3, '0')} — should be 0600 (chmod 600 ${file})\n`,
			)
		}
	} catch {
		// stat failure is non-fatal — the caller already read the file
	}
}
