/**
 * Dev-source helpers for the web viewer (spec: web-viewer unification).
 * Pure — no tldraw imports — so `bun` can run the tests bare.
 */
export type WebViewerKind = 'file' | 'dev'

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]']

/** "http://localhost:3000/x", "3000", ":3000" → {port, path}; non-local → null. */
export function parseDevInput(raw: string): { port: number; path: string } | null {
	const t = raw.trim()
	const bare = /^:?(\d{1,5})$/.exec(t)
	if (bare) {
		const port = Number(bare[1])
		return port > 0 && port < 65536 ? { port, path: '/' } : null
	}
	try {
		const url = new URL(t)
		if (!LOCAL_HOSTS.includes(url.hostname) || !url.port) return null
		return { port: Number(url.port), path: `${url.pathname}${url.search}` || '/' }
	} catch {
		return null
	}
}

/** SECURITY: file content is arbitrary disk bytes — never allow-same-origin.
 * Dev content is the team's own running code — same-origin matches the
 * retired iframe control's grant. Derived here and ONLY here. */
export function sandboxFor(kind: WebViewerKind): string {
	return kind === 'dev'
		? 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads'
		: 'allow-scripts allow-forms allow-downloads'
}

/** iframe src for a shape's props; missing kind = 'file' (pre-migration records). */
export function srcFor(props: { kind?: WebViewerKind; path: string; port?: number; rev?: number }): string {
	const rev = props.rev ?? 0
	if (props.kind === 'dev' && typeof props.port === 'number') {
		const path = props.path.startsWith('/') ? props.path : `/${props.path || ''}`
		return `/dev/${props.port}${path}${path.includes('?') ? '&' : '?'}rev=${rev}`
	}
	return `/files/${props.path.split('/').map(encodeURIComponent).join('/')}?rev=${rev}`
}
