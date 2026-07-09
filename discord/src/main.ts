// EnsembleWorks Discord bot — entry point. Wires the discord.js gateway to the
// inbound router and the internal /post outbound face (see bot.ts).
import { DiscordJsGateway } from './adapter.discordjs.ts'
import { wireBot } from './bot.ts'

const token = process.env.DISCORD_BOT_TOKEN
const secret = process.env.DISCORD_INTERNAL_SECRET ?? ''
const port = Number(process.env.PORT ?? 8790)
const syncBase = process.env.SYNC_BASE ?? 'http://127.0.0.1:8788'

if (!secret) console.warn('[discord] DISCORD_INTERNAL_SECRET unset — outbound /post will reject all callers')

if (process.argv.includes('--check')) {
	// Deploy boot-check (parallels `transcriber --check`): prove the compiled
	// binary links and the internal /post face binds on an ephemeral loopback
	// port — WITHOUT connecting to Discord. Then exit 0.
	const gateway = new DiscordJsGateway(token ?? '')
	const { httpFace } = wireBot(gateway, { syncBase, secret, port: 0 })
	console.log(`[discord] --check ok (/post bound on 127.0.0.1:${httpFace.port})`)
	httpFace.stop()
	process.exit(0)
}

// Construct the gateway. Even without a token we still start the internal /post
// face so outbound wiring is inspectable; inbound just won't connect.
const gateway = new DiscordJsGateway(token ?? '')
const { httpFace } = wireBot(gateway, { syncBase, secret, port })
console.log(`[discord] internal /post on 127.0.0.1:${httpFace.port}; sync base ${syncBase}`)

if (!token) {
	console.warn('[discord] DISCORD_BOT_TOKEN unset — inbound gateway not connected (outbound /post still available)')
} else {
	gateway.connect().then(
		() => console.log('[discord] gateway connected'),
		(err) => console.error('[discord] gateway connect failed (outbound /post still available):', err),
	)
}
