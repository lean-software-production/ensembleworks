import { execSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import { defineConfig, type ServerOptions } from 'vite'
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

// Shared by BOTH the dev server and `vite preview`. Vite does NOT inherit
// server.proxy into preview, and the e2e load-perf harness
// (e2e/playwright.load.config.ts) drives a PRODUCTION build through preview —
// without this the preview server 404s /sync and /api and the v2 app can never
// dial its WebSocket. One definition, two consumers: a drifted copy would make
// the harness measure a different backend wiring than dev uses.
const PROXY = {
	'/sync': { target: `ws://localhost:${SYNC_PORT}`, ws: true },
	'/uploads': `http://localhost:${SYNC_PORT}`,
	'/files': `http://localhost:${SYNC_PORT}`,
	'^/api/terminal/(health|sessions|ws)': { target: `ws://localhost:${TERM_PORT}`, ws: true },
	'/api': { target: `http://localhost:${SYNC_PORT}`, ws: true },
} as const

export default defineConfig({
	// wasm() ALONE (no vite-plugin-top-level-await, default build target):
	// the loro-crdt fix needs only the wasm plugin — it handles the dev
	// server/optimizer's bundler/index.js raw-ESM `.wasm` import, and the
	// production build's browser/index.js path never needed a plugin at all
	// (Preflight P1, as amended during Unit 12 review: the recorded
	// two-plugin diff was sufficient but not minimal — the TLA plugin only
	// existed to fix its own transform failure at the default target, and
	// wrapping every chunk in an async IIFE cost the entry chunk +106% raw /
	// +30% gzip for nothing).
	plugins: [react(), wasm()],
	define: {
		__APP_VERSION__: JSON.stringify(appVersion()),
	},
	build: {
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
		proxy: PROXY,
	},
	preview: {
		host: '127.0.0.1',
		strictPort: true,
		proxy: PROXY,
	},
})
