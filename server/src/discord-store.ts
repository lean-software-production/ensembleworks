/**
 * Discord bindings store — a single JSON file (DATA_DIR/discord/bindings.json)
 * holding every binding across all rooms. Bindings are low-volume (a handful
 * per deployment) but inbound routing needs a GLOBAL reverse lookup
 * (channelId → binding across ALL rooms), so one file, not per-room files.
 *
 * Follows roadmap-store.ts: async fs only, atomic tmp+rename writes, and a
 * single promise-chain mutex so concurrent read-modify-write calls (create,
 * remove) serialize instead of clobbering each other. The list* reads can read
 * the file directly.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DiscordBinding } from '@ensembleworks/contracts'

type NewBinding = Omit<DiscordBinding, 'id' | 'createdAt'>

export interface DiscordStore {
	create(input: NewBinding): Promise<DiscordBinding>
	listByRoom(room: string): Promise<DiscordBinding[]>
	listInboundByChannel(channelId: string): Promise<DiscordBinding[]> // direction==='in' && channelId match
	listOutbound(room: string): Promise<DiscordBinding[]> // direction==='out' && room match
	remove(id: string): Promise<void>
}

export function createDiscordStore(dataDir: string): DiscordStore {
	const dir = path.join(dataDir, 'discord')
	const file = path.join(dir, 'bindings.json')
	const tmp = path.join(dir, 'bindings.json.tmp')

	// Promise-chain mutex: each write chains onto the previous one. One global
	// lock is enough — it's a single file.
	let lock: Promise<void> = Promise.resolve()

	async function withLock<T>(fn: () => Promise<T>): Promise<T> {
		const prev = lock
		let release!: () => void
		lock = new Promise<void>((r) => (release = r))
		await prev
		try {
			return await fn()
		} finally {
			release()
		}
	}

	async function load(): Promise<DiscordBinding[]> {
		try {
			return JSON.parse(await readFile(file, 'utf8'))
		} catch {
			// Missing file (first run) or a torn write: start empty.
			return []
		}
	}

	async function save(all: DiscordBinding[]): Promise<void> {
		await mkdir(dir, { recursive: true })
		// Write to a .tmp file then atomically rename over the target so a crash
		// mid-write leaves the old file intact rather than torn JSON.
		await writeFile(tmp, JSON.stringify(all, null, '\t'))
		await rename(tmp, file)
	}

	return {
		async create(input) {
			return withLock(async () => {
				const all = await load()
				const binding: DiscordBinding = {
					...input,
					id: randomUUID(),
					createdAt: Date.now(),
				}
				all.push(binding)
				await save(all)
				return binding
			})
		},
		async listByRoom(room) {
			return (await load()).filter((b) => b.room === room)
		},
		async listInboundByChannel(channelId) {
			return (await load()).filter((b) => b.direction === 'in' && b.channelId === channelId)
		},
		async listOutbound(room) {
			return (await load()).filter((b) => b.direction === 'out' && b.room === room)
		},
		async remove(id) {
			return withLock(async () => {
				const all = await load()
				await save(all.filter((b) => b.id !== id))
			})
		},
	}
}
