/**
 * Dev-source helpers for the web viewer (spec: web-viewer unification).
 * Pure — no tldraw imports — so `bun` can run the tests bare.
 */
export type WebViewerKind = 'file' | 'dev'

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]']

/** "http://localhost:3000/x", "localhost:3000", "3000", ":3000" → {port, path}; non-local → null. */
export function parseDevInput(raw: string): { port: number; path: string } | null {
	const t = raw.trim()
	const bare = /^:?(\d{1,5})$/.exec(t)
	if (bare) {
		const port = Number(bare[1])
		return port > 0 && port < 65536 ? { port, path: '/' } : null
	}
	// Schemeless "localhost:3000" / "127.0.0.1:5173" / "[::1]:3000" is the
	// creation prompt's own example — `new URL` on a bare host:port parses
	// "localhost:" as a scheme and fails, so retry with an http:// prefix
	// whenever the input doesn't already declare one.
	const withScheme = /^https?:\/\//.test(t) ? t : `http://${t}`
	try {
		const url = new URL(withScheme)
		if (!LOCAL_HOSTS.includes(url.hostname) || !url.port) return null
		return { port: Number(url.port), path: `${url.pathname}${url.search}` || '/' }
	} catch {
		return null
	}
}

/** Single definition of dev-ness — sandboxFor and srcFor MUST agree, since a
 * mismatch (e.g. 'dev' with no port) would grant the same-origin sandbox to
 * content actually served from the file route. */
export function isDevSource(props: { kind?: WebViewerKind; port?: number }): boolean {
	return props.kind === 'dev' && typeof props.port === 'number'
}

/** SECURITY: file content is arbitrary disk bytes — never allow-same-origin.
 * Dev content is the team's own running code — same-origin matches the
 * retired iframe control's grant. Derived here and ONLY here, from the same
 * isDevSource predicate srcFor uses. */
export function sandboxFor(props: { kind?: WebViewerKind; port?: number }): string {
	return isDevSource(props)
		? 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads'
		: 'allow-scripts allow-forms allow-downloads'
}

/** iframe src for a shape's props; missing kind = 'file' (pre-migration records). */
export function srcFor(props: { kind?: WebViewerKind; path: string; port?: number; rev?: number }): string {
	const rev = props.rev ?? 0
	if (isDevSource(props)) {
		const path = props.path.startsWith('/') ? props.path : `/${props.path || ''}`
		return `/dev/${props.port}${path}${path.includes('?') ? '&' : '?'}rev=${rev}`
	}
	return `/files/${props.path.split('/').map(encodeURIComponent).join('/')}?rev=${rev}`
}
