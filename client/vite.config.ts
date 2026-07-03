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

// Vite serves the app and proxies the backend services. We run it the same way
// in the devcontainer and on the dogfooding server, so it always sits behind a
// TLS-terminating reverse proxy on a single public origin (Caddy :8080, then
// Codespaces port-forwarding or a Cloudflare Tunnel). Behind that proxy Vite
// must (a) accept the public Host header and (b) point its HMR client at the
// public wss endpoint — otherwise it 403s the request and HMR can't connect.
const CADDY_PORT = 8080

// GitHub Codespaces injects the forwarded host; derive it automatically.
const codespace = process.env.CODESPACE_NAME
const forwardingDomain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN

// Any other public host (e.g. the Cloudflare hostname on the Debian box):
// set ENSEMBLEWORKS_PUBLIC_HOST=canvas.example.com. Unset for plain localhost.
const publicHost = process.env.ENSEMBLEWORKS_PUBLIC_HOST

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
		: publicHost
			? {
					allowedHosts: [publicHost],
					hmr: { protocol: 'wss', host: publicHost, clientPort: 443 },
				}
			: {}

export default defineConfig({
	plugins: [react()],
	define: {
		__APP_VERSION__: JSON.stringify(appVersion()),
	},
	server: {
		// Caddy hard-targets localhost:5173, so a busy port must fail loudly
		// rather than let Vite silently bind 5174 and 502 through Caddy.
		strictPort: true,
		...proxiedServer,
		proxy: {
			'/sync': { target: 'ws://localhost:8788', ws: true },
			'/uploads': 'http://localhost:8788',
			'/api': { target: 'http://localhost:8788', ws: true },
			'/term': { target: 'ws://localhost:8789', ws: true },
		},
	},
})
