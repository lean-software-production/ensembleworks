// @ts-check
/**
 * Pure logic for bin/dev — the service table, gating rules and parsers. No
 * I/O here: everything takes a plain context object so it can be unit-tested
 * (bin/dev.test.ts) without tmux, sockets or a filesystem. The I/O side
 * (tmux, health polls, CLI) lives in bin/dev-main.mjs.
 */

export const PORTS = {
	sync: 8788,
	term: 8789,
	client: 5173,
	caddy: 8080,
	livekit: 7880,
	whisper: 8091, // 8090 is the shared browser (neko)
}

/**
 * Resolve the browser-facing public origin. ENSEMBLEWORKS_PUBLIC_ORIGIN
 * (`scheme://host[:port]`, scheme optional → http) is the general form, so a
 * remote box reachable over the LAN as plain http on :8080 works — not only a
 * TLS edge on :443. ENSEMBLEWORKS_PUBLIC_HOST is kept as back-compat shorthand
 * for `https://<host>` (tailscale serve / a tunnel). Returns null for plain
 * localhost (neither set). Mirrored in client/vite.config.ts (HMR +
 * allowedHosts) — keep the two in sync.
 * @param {string | undefined | null} origin
 * @param {string | undefined | null} host
 * @returns {{ scheme: 'http' | 'https', host: string, port: number | null } | null}
 */
export function parsePublicOrigin(origin, host) {
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

/**
 * Canonical `scheme://host[:port]` string for a parsed origin (or null).
 * @param {{ scheme: string, host: string, port: number | null } | null} o
 */
export function originToString(o) {
	return o ? `${o.scheme}://${o.host}${o.port ? `:${o.port}` : ''}` : null
}

/**
 * Browser-facing LiveKit signaling URL (behind Caddy's /livekit route) for a
 * parsed origin: wss for https, ws otherwise; localhost caddy when null.
 * @param {{ scheme: string, host: string, port: number | null } | null} o
 */
export function livekitBrowserUrl(o) {
	if (!o) return `ws://localhost:${PORTS.caddy}/livekit`
	const ws = o.scheme === 'https' ? 'wss' : 'ws'
	return `${ws}://${o.host}${o.port ? `:${o.port}` : ''}/livekit`
}

/**
 * Which role bin/dev plays. Inside the container the Dockerfile sets
 * ENSEMBLEWORKS_IN_DEVCONTAINER=1 → the **engine** that runs the tmux stack;
 * ENSEMBLEWORKS_NATIVE=1 forces the engine on the host too (no-Docker escape
 * hatch). Otherwise, on the host, bin/dev is the **controller** that drives the
 * devcontainer (up starts it; status/logs/… forward into it).
 * @param {Record<string, string | undefined>} env
 * @returns {'engine' | 'controller'}
 */
export function resolveMode(env) {
	if (env.ENSEMBLEWORKS_IN_DEVCONTAINER === '1' || env.ENSEMBLEWORKS_NATIVE === '1') return 'engine'
	return 'controller'
}

/**
 * The devcontainer mounts the workspace at /workspaces/<folder-name>; a
 * forwarded `docker exec` must cd there (the image's WORKDIR isn't it, so a
 * bare `bin/dev` wouldn't be found).
 * @param {string} repoDir  absolute host path to the repo
 */
export function workspaceDirFor(repoDir) {
	return `/workspaces/${repoDir.split('/').filter(Boolean).pop() ?? 'workspace'}`
}

/**
 * The `docker` argv that runs bin/dev inside the devcontainer with the right
 * cwd. An array (for execFileSync/spawnSync) so nothing needs shell quoting.
 * @param {string} container      container id or name
 * @param {string} workspaceDir   cwd inside the container (workspaceDirFor)
 * @param {string[]} args         the bin/dev subcommand + flags to forward
 * @returns {string[]}
 */
export function forwardArgv(container, workspaceDir, args) {
	return ['exec', '-w', workspaceDir, container, 'bin/dev', ...args]
}

/**
 * What `bin/dev attach` prints on the host instead of nesting into the
 * container's tmux (which traps your prefix and strands you).
 * @param {string} container  container id or name
 */
export function attachInstructions(container) {
	return [
		"Attach to the devcontainer's tmux stack with:",
		'',
		`  docker exec -it ${container} tmux attach -t workspace`,
		'',
		'Detach again with:  Ctrl-b Ctrl-b d   (double-tap sends the prefix to the inner tmux)',
		'Or drive it without attaching:  bin/dev status | logs <svc> | restart <svc>',
	].join('\n')
}

/**
 * Wrap a service command so its tmux window survives a crash OR a Ctrl-C: run
 * the command, then drop into an interactive shell with the exit code and
 * scrollback intact (instead of the window vanishing, which is what hid a
 * missing-deps failure — and what closes the window when you C-c a service to
 * restart it). The `trap ":" INT` is load-bearing: without it, a child killed
 * *by* SIGINT (e.g. vite under `npm run dev`) makes this non-interactive
 * wrapper shell abort the list before reaching `exec bash`, so the window
 * closes. tsx-based services hid this because tsx catches SIGINT and exits 0;
 * vite does not. The trap makes the wrapper survive the signal while the
 * child (which resets the trap on exec) still dies. This is race-free — no
 * reliance on remain-on-exit landing before a fast exit — and scoped to these
 * windows, so it never touches the human-facing canvas terminals that share
 * deploy/tmux-ensembleworks.conf. (Ported verbatim from the retired
 * ~/Work/ensembleworks-devserver launcher.)
 *
 * @param {string} cmd
 * @param {string} label
 */
export function hold(cmd, label) {
	return `trap ":" INT; ${cmd}; code=$?; echo; echo "[${label} exited $code] — shell follows, scrollback intact"; exec bash`
}

/** @param {string} text  .nvmrc content, e.g. "22.22.3\n" or "v22.22.3" */
export function parseNvmrc(text) {
	return text.trim().replace(/^v/, '')
}

/**
 * KEY=VALUE per line with `set -a` spirit: comments/blanks skipped, optional
 * `export ` prefix, surrounding single/double quotes stripped. Deliberately
 * NO interpolation or multi-line values — dev.env is data, not shell.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseDotEnv(text) {
	/** @type {Record<string, string>} */
	const out = {}
	for (const line of text.split('\n')) {
		const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
		if (!m) continue
		let v = m[2].trim()
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
			v = v.slice(1, -1)
		}
		out[m[1]] = v
	}
	return out
}

/**
 * @typedef {object} ServiceCtx
 * @property {string} repoDir
 * @property {string} dataDir              DATA_DIR for the sync server
 * @property {{ scheme: 'http' | 'https', host: string, port: number | null } | null} publicOrigin
 *           browser-facing origin (parsePublicOrigin) or null = localhost
 * @property {string | null} livekitNodeIp  --node-ip for livekit --dev (the IP the
 *           SFU advertises for media; a LAN IP makes cross-machine voice work). null → 127.0.0.1
 * @property {string | null} livekitConf   path to livekit-dev.yaml IFF the file exists, else null
 * @property {string} whisperModel         ggml model path (existence pre-checked by the caller)
 * @property {string | null} tailscaleIp   first tailscale IPv4, for neko NAT1TO1
 * @property {{ caddy: boolean, livekit: boolean, whisper: boolean, docker: boolean }} has
 *           binary presence; `whisper` means binary AND model file present
 * @property {Record<string, string | undefined>} env  process env AFTER the dev.env merge
 */

/**
 * @typedef {object} Service
 * @property {string} name      tmux window name
 * @property {boolean} enabled
 * @property {string} reason    one line: why it will / won't run
 * @property {string} cmd       window command (pre-hold()). Inline env is
 *   non-secret only (dev-mode keys, urls, paths); real secrets from dev.env
 *   ride the inherited tmux-server environment and never appear in argv.
 * @property {{ kind: 'http', url: string } | { kind: 'port', port: number } | null} health
 */

/**
 * The service table. Window order matches the retired launcher: sync first.
 * @param {ServiceCtx} ctx
 * @returns {Service[]}
 */
export function buildServices(ctx) {
	/** @type {Service[]} */
	const services = []

	// LiveKit: config file (real deployment shape — needs real keys in the env)
	// wins over --dev mode (built-in devkey/secret; zero accounts).
	const livekitKeysOk = ctx.livekitConf
		? Boolean(ctx.env.LIVEKIT_API_KEY && ctx.env.LIVEKIT_API_SECRET)
		: true
	const livekitOn = ctx.has.livekit && livekitKeysOk

	// Browser-facing signaling URL goes through Caddy's /livekit route: wss for
	// an https edge, plain ws for LAN http / localhost — derived from the same
	// public origin the client (vite) uses for HMR/allowedHosts.
	const livekitPublicUrl = livekitBrowserUrl(ctx.publicOrigin)
	const publicOriginStr = originToString(ctx.publicOrigin)

	const syncEnv = [`DATA_DIR='${ctx.dataDir}'`]
	if (livekitOn) {
		syncEnv.push(
			`LIVEKIT_URL='${livekitPublicUrl}'`,
			`LIVEKIT_API_URL='http://localhost:${PORTS.livekit}'`,
		)
		// --dev mode keys are public constants, safe inline. Config-file mode
		// keys come from dev.env via the inherited environment instead.
		if (!ctx.livekitConf) syncEnv.push(`LIVEKIT_API_KEY='devkey'`, `LIVEKIT_API_SECRET='secret'`)
	}
	services.push({
		name: 'sync',
		enabled: true,
		reason: 'always',
		cmd: `${syncEnv.join(' ')} npm run dev --workspace=server`,
		health: { kind: 'http', url: `http://localhost:${PORTS.sync}/api/health` },
	})

	services.push({
		name: 'term',
		enabled: true,
		reason: 'always',
		cmd: 'npm run dev:term --workspace=server',
		health: { kind: 'port', port: PORTS.term },
	})

	services.push({
		name: 'client',
		enabled: true,
		reason: 'always',
		cmd: `${publicOriginStr ? `ENSEMBLEWORKS_PUBLIC_ORIGIN='${publicOriginStr}' ` : ''}npm run dev --workspace=client`,
		health: { kind: 'port', port: PORTS.client },
	})

	// Direct LAN access needs a secure context (crypto.randomUUID, the mic), so
	// bin/dev can make Caddy terminate TLS itself with its internal CA when
	// ENSEMBLEWORKS_CADDY_TLS=internal and the origin is https. The Caddyfile
	// reads these; both default to the plain-:8080 shape (upstream-TLS/native).
	const caddyTlsInternal =
		ctx.env.ENSEMBLEWORKS_CADDY_TLS === 'internal' && ctx.publicOrigin?.scheme === 'https'
	const caddySite =
		caddyTlsInternal && ctx.publicOrigin
			? `https://${ctx.publicOrigin.host}:${ctx.publicOrigin.port ?? PORTS.caddy}`
			: `:${PORTS.caddy}`
	// default_sni: a browser hitting a bare IP sends no SNI, so Caddy needs a
	// default to select the internal cert (else the handshake internal-errors).
	const caddyGlobal = caddyTlsInternal && ctx.publicOrigin ? `default_sni ${ctx.publicOrigin.host}` : ''
	const caddyEnv = `ENSEMBLEWORKS_CADDY_SITE='${caddySite}' ENSEMBLEWORKS_CADDY_TLS_DIRECTIVE='${caddyTlsInternal ? 'tls internal' : ''}' ENSEMBLEWORKS_CADDY_GLOBAL='${caddyGlobal}'`
	services.push({
		name: 'caddy',
		enabled: ctx.has.caddy,
		reason: !ctx.has.caddy
			? 'caddy not on PATH — no :8080 edge (/dev/{port}, /livekit, /shared-browser routes)'
			: caddyTlsInternal
				? `edge at ${caddySite} (TLS internal — self-signed, click through once)`
				: 'edge on :8080',
		cmd: `${caddyEnv} caddy run --config '${ctx.repoDir}/deploy/Caddyfile' --adapter caddyfile`,
		health: { kind: 'port', port: PORTS.caddy },
	})

	services.push({
		name: 'livekit',
		enabled: livekitOn,
		reason: !ctx.has.livekit
			? 'livekit-server not on PATH — voice/video disabled'
			: !livekitKeysOk
				? `${ctx.livekitConf} present but LIVEKIT_API_KEY/LIVEKIT_API_SECRET unset (put them in dev.env)`
				: ctx.livekitConf
					? `config ${ctx.livekitConf}`
					: 'dev mode (built-in devkey/secret)',
		// --node-ip is what the SFU advertises for media. 127.0.0.1 keeps voice
		// localhost-only; a LAN IP (auto-detected on the host) makes voice work
		// from a browser on another LAN machine. Media rides the published udp
		// mux (7882) regardless.
		cmd: ctx.livekitConf
			? `livekit-server --config '${ctx.livekitConf}'`
			: `livekit-server --dev --bind 0.0.0.0 --node-ip ${ctx.livekitNodeIp ?? '127.0.0.1'}`,
		health: { kind: 'port', port: PORTS.livekit },
	})

	services.push({
		name: 'whisper',
		enabled: ctx.has.whisper,
		reason: ctx.has.whisper
			? `local STT on :${PORTS.whisper}`
			: 'whisper-server (or its model) missing — no keyless transcription',
		// --inference-path makes whisper.cpp serve the OpenAI-compatible path,
		// so STT_URL=http://localhost:8091/v1 satisfies the scribe's contract.
		cmd: `whisper-server --host 127.0.0.1 --port ${PORTS.whisper} -m '${ctx.whisperModel}' --inference-path /v1/audio/transcriptions`,
		health: { kind: 'port', port: PORTS.whisper },
	})

	// Scribe: needs the SFU (to hear the room) and an STT backend. Resolution:
	// explicit STT_URL (dev.env) > hosted STT_API_KEY (transcriber defaults to
	// Groq) > the local whisper window above.
	const whisperOn = services[services.length - 1].enabled
	const localSttUrl = whisperOn ? `http://localhost:${PORTS.whisper}/v1` : undefined
	const scribeOn = livekitOn && Boolean(ctx.env.STT_URL || ctx.env.STT_API_KEY || localSttUrl)
	const scribeExports = [`export LIVEKIT_URL='ws://localhost:${PORTS.livekit}'`]
	if (!ctx.env.STT_URL && !ctx.env.STT_API_KEY && localSttUrl) {
		scribeExports.push(`export STT_URL='${localSttUrl}' STT_MODEL='${ctx.env.STT_MODEL ?? 'whisper-1'}'`)
	}
	services.push({
		name: 'scribe',
		enabled: scribeOn,
		reason: !livekitOn
			? 'needs LiveKit running (it subscribes to the room audio)'
			: scribeOn
				? ctx.env.STT_URL
					? `STT at ${ctx.env.STT_URL}`
					: ctx.env.STT_API_KEY
						? 'hosted STT (STT_API_KEY set)'
						: `local whisper at ${localSttUrl}`
				: 'no STT backend — set STT_API_KEY (e.g. Groq) or STT_URL in dev.env, or install whisper-server',
		// Waits for BOTH the sync server (its token fetch) and the SFU's
		// signaling port so its startup doesn't race the others.
		cmd: `${scribeExports.join('; ')}; until curl -fsS http://localhost:${PORTS.sync}/api/health >/dev/null 2>&1 && timeout 1 bash -c '</dev/tcp/localhost/${PORTS.livekit}' 2>/dev/null; do sleep 2; done; npm run dev --workspace=transcriber`,
		health: null,
	})

	// Shared browser: a neko container (real Firefox streamed over WebRTC),
	// proxied by Caddy's /shared-browser route. Native hosts with docker only —
	// the devcontainer deliberately excludes it (docker-in-docker).
	const nekoUdp = ctx.env.NEKO_UDPMUX ?? '52000'
	const nekoNat = ctx.env.NEKO_NAT1TO1 ?? ctx.tailscaleIp ?? '127.0.0.1'
	const sbOn = ctx.has.docker && ctx.env.SHARED_BROWSER_ENABLE !== '0'
	services.push({
		name: 'shared-browser',
		enabled: sbOn,
		reason: !ctx.has.docker
			? 'docker not on PATH — shared browser off (fine; it is optional)'
			: sbOn
				? `neko on :8090, WebRTC udp ${nekoUdp} at ${nekoNat}`
				: 'disabled by SHARED_BROWSER_ENABLE=0',
		cmd:
			'docker rm -f ensembleworks-shared-browser >/dev/null 2>&1; ' +
			'docker run --rm --name ensembleworks-shared-browser --shm-size=2g ' +
			`-p 127.0.0.1:8090:8080 -p ${nekoUdp}:${nekoUdp}/udp ` +
			`-e NEKO_DESKTOP_SCREEN='${ctx.env.NEKO_SCREEN ?? '1280x720@30'}' ` +
			'-e NEKO_MEMBER_PROVIDER=multiuser ' +
			`-e NEKO_MEMBER_MULTIUSER_USER_PASSWORD='${ctx.env.NEKO_USER_PASSWORD ?? 'neko'}' ` +
			`-e NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD='${ctx.env.NEKO_ADMIN_PASSWORD ?? 'admin'}' ` +
			'-e NEKO_SESSION_IMPLICIT_HOSTING=true -e NEKO_SESSION_INACTIVE_CURSORS=true ' +
			`-e NEKO_WEBRTC_UDPMUX=${nekoUdp} -e NEKO_WEBRTC_NAT1TO1='${nekoNat}' ` +
			`'${ctx.env.NEKO_IMAGE ?? 'ghcr.io/m1k1o/neko/firefox:latest'}'`,
		health: null,
	})

	return services
}
