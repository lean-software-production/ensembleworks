import { execSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import { defineConfig, type ServerOptions } from 'vite'
import topLevelAwait from 'vite-plugin-top-level-await'
import wasm from 'vite-plugin-wasm'

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
// The dev stack can run at a port offset (multiple stacks per host): bin/dev
// passes ENSEMBLEWORKS_PORT_OFFSET into this process. Mirror of portsFor() in
// bin/dev-lib.mjs — keep in sync.
const PORT_OFFSET = Number(process.env.ENSEMBLEWORKS_PORT_OFFSET || 0)
const CADDY_PORT = 8080 + PORT_OFFSET
const CLIENT_PORT = 5173 + PORT_OFFSET
const SYNC_PORT = 8788 + PORT_OFFSET
const TERM_PORT = 8789 + PORT_OFFSET

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
	plugins: [react(), wasm(), topLevelAwait()],
	define: {
		__APP_VERSION__: JSON.stringify(appVersion()),
	},
	build: {
		// vite-plugin-top-level-await (required by vite-plugin-wasm for the
		// loro-crdt wasm-bindgen bundle) needs a target that natively supports
		// top-level await; the default modern-browser target list doesn't.
		target: 'esnext',
		// One 3 MB chunk means every release invalidates the whole bundle. The
		// heavyweights (tldraw, LiveKit, xterm, React) change only on dependency
		// bumps, so give each a stable chunk that stays browser-cached across
		// deploys; the remaining app chunk is what actually churns. All of them
		// load at boot regardless — this is cache granularity, not lazy loading.
		rollupOptions: {
			output: {
				manualChunks(id: string) {
					if (!id.includes('node_modules')) return undefined
					if (id.includes('/node_modules/@tldraw/') || id.includes('/node_modules/tldraw/'))
						return 'tldraw'
					if (id.includes('/node_modules/livekit-client/')) return 'livekit'
					if (id.includes('/node_modules/@xterm/')) return 'xterm'
					if (id.includes('/node_modules/react')) return 'react'
					return undefined
				},
			},
		},
		// tldraw alone is legitimately ~1.5 MB minified; keep the warning armed
		// just above it so it still fires on real regressions.
		chunkSizeWarningLimit: 1800,
	},
	server: {
		// Bind the IPv4 loopback explicitly. The dev server sits behind Caddy,
		// which dials 127.0.0.1 on the client port (5173 + offset) (see
		// deploy/Caddyfile). The container also sets
		// NODE_OPTIONS=--dns-result-order=ipv4first so `localhost` resolves to
		// 127.0.0.1, but pinning the host here removes any IPv4/IPv6 ambiguity.
		host: '127.0.0.1',
		port: CLIENT_PORT,
		// Caddy hard-targets the client port (5173 + offset) on 127.0.0.1, so a
		// busy port must fail loudly rather than let Vite silently bind the next
		// port and 502 through Caddy.
		strictPort: true,
		...proxiedServer,
		proxy: {
			'/sync': { target: `ws://localhost:${SYNC_PORT}`, ws: true },
			'/uploads': `http://localhost:${SYNC_PORT}`,
			'/files': `http://localhost:${SYNC_PORT}`,
			// Terminal local plane (health/sessions/ws) is served by the gateway
			// process; the relay plane (status/list/connect/relay) stays on the sync
			// server. Must precede the '/api' catch-all. The alternation also covers
			// /sessions/:id.
			'^/api/terminal/(health|sessions|ws)': { target: `ws://localhost:${TERM_PORT}`, ws: true },
			'/api': { target: `http://localhost:${SYNC_PORT}`, ws: true },
		},
	},
})
