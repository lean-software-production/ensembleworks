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
 * @property {string | null} publicHost    ENSEMBLEWORKS_PUBLIC_HOST (tailnet/tunnel edge) or null = localhost
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

	// Browser-facing signaling URL goes through Caddy's /livekit route: wss
	// when a TLS edge fronts us (public host), plain ws for localhost.
	const livekitPublicUrl = ctx.publicHost
		? `wss://${ctx.publicHost}/livekit`
		: `ws://localhost:${PORTS.caddy}/livekit`

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
		cmd: `${ctx.publicHost ? `ENSEMBLEWORKS_PUBLIC_HOST='${ctx.publicHost}' ` : ''}npm run dev --workspace=client`,
		health: { kind: 'port', port: PORTS.client },
	})

	services.push({
		name: 'caddy',
		enabled: ctx.has.caddy,
		reason: ctx.has.caddy
			? 'edge on :8080'
			: 'caddy not on PATH — no :8080 edge (/dev/{port}, /livekit, /shared-browser routes)',
		cmd: `caddy run --config '${ctx.repoDir}/deploy/Caddyfile' --adapter caddyfile`,
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
		cmd: ctx.livekitConf
			? `livekit-server --config '${ctx.livekitConf}'`
			: 'livekit-server --dev --bind 0.0.0.0 --node-ip 127.0.0.1',
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
