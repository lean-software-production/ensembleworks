import { execSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import { defineConfig, type ServerOptions } from 'vite'

// Stamp the build with the git-described version so the client can show it
// (see the About dialog). Tolerant of non-git builds (e.g. tarball deploys).
function appVersion(): string {
	try {
		return execSync('git describe --tags --always --dirty', { encoding: 'utf8' }).trim()
	} catch {
		return '0.0.0-dev'
	}
}

// Vite serves the app and proxies the backend services. It always sits behind
// Caddy (:8080) on a single public origin. That origin may be a TLS edge
// (Codespaces port-forwarding, a Cloudflare Tunnel, tailscale serve — wss/:443)
// OR a plain-http address when a teammate reaches a remote box directly on the
// LAN (ws/:8080). Behind either, Vite must (a) accept the public Host header
// and (b) point its HMR client at a reachable ws endpoint — otherwise it 403s
// the request and HMR can't connect.
const CADDY_PORT = 8080

// GitHub Codespaces injects the forwarded host; derive it automatically.
const codespace = process.env.CODESPACE_NAME
const forwardingDomain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN

// Any other public origin: ENSEMBLEWORKS_PUBLIC_ORIGIN=scheme://host[:port]
// (scheme optional → http, e.g. http://192.168.1.77:8080 for LAN access), or
// the back-compat ENSEMBLEWORKS_PUBLIC_HOST (shorthand for https://<host>).
// Unset → plain localhost. Mirror of parsePublicOrigin() in bin/dev-lib.mjs —
// keep the two in sync.
function parsePublicOrigin(origin?: string, host?: string) {
	const trimmed = origin?.trim()
	const raw = trimmed
		? /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
			? trimmed
			: `http://${trimmed}`
		: host?.trim()
			? `https://${host.trim()}`
			: ''
	if (!raw) return null
	try {
		const u = new URL(raw)
		return {
			scheme: u.protocol === 'https:' ? 'https' : 'http',
			host: u.hostname,
			port: u.port ? Number(u.port) : null,
		}
	} catch {
		return null
	}
}

const origin = parsePublicOrigin(
	process.env.ENSEMBLEWORKS_PUBLIC_ORIGIN,
	process.env.ENSEMBLEWORKS_PUBLIC_HOST,
)

const proxiedServer: Partial<ServerOptions> =
	codespace && forwardingDomain
		? {
				allowedHosts: [`.${forwardingDomain}`],
				hmr: {
					protocol: 'wss',
					host: `${codespace}-${CADDY_PORT}.${forwardingDomain}`,
					clientPort: 443,
				},
			}
		: origin
			? {
					allowedHosts: [origin.host],
					hmr: {
						protocol: origin.scheme === 'https' ? 'wss' : 'ws',
						host: origin.host,
						clientPort: origin.port ?? (origin.scheme === 'https' ? 443 : 80),
					},
				}
			: {}

export default defineConfig({
	plugins: [react()],
	define: {
		__APP_VERSION__: JSON.stringify(appVersion()),
	},
	server: {
		// Bind the IPv4 loopback explicitly. The dev server sits behind Caddy,
		// which dials 127.0.0.1:5173 (see deploy/Caddyfile). The container also
		// sets NODE_OPTIONS=--dns-result-order=ipv4first so `localhost` resolves to
		// 127.0.0.1, but pinning the host here removes any IPv4/IPv6 ambiguity.
		host: '127.0.0.1',
		// Caddy hard-targets 127.0.0.1:5173, so a busy port must fail loudly
		// rather than let Vite silently bind 5174 and 502 through Caddy.
		strictPort: true,
		...proxiedServer,
		proxy: {
			'/sync': { target: 'ws://localhost:8788', ws: true },
			'/uploads': 'http://localhost:8788',
			'/files': 'http://localhost:8788',
			// Terminal local plane (health/sessions/ws) is served by the :8789 gateway
			// process; the relay plane (status/list/connect/relay) stays on :8788. Must
			// precede the '/api' catch-all. The alternation also covers /sessions/:id.
			'^/api/terminal/(health|sessions|ws)': { target: 'ws://localhost:8789', ws: true },
			'/api': { target: 'http://localhost:8788', ws: true },
		},
	},
})
