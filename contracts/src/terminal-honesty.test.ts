/**
 * The profile must stay honest against the real emulator we ship. Headless
 * xterm is the oracle for the CSI family ONLY — it has no browser colour
 * manager, so OSC 10/11 are asserted in the client suite instead
 * (client/src/terminal/identityHandlers.test.ts).
 */
import { describe, expect, test } from 'bun:test'
import { Terminal } from '@xterm/headless'
import { readFileSync } from 'node:fs'
import { CAPABILITY_PROFILE } from './terminal-identity.js'

function ask(term: Terminal, query: string): Promise<string> {
	return new Promise((resolve) => {
		let acc = ''
		const d = term.onData((data) => {
			acc += data
			d.dispose()
			resolve(acc)
		})
		term.write(query)
		// a query xterm ignores produces no data; settle after the write flushes
		term.write('', () => setTimeout(() => { d.dispose(); resolve(acc) }, 20))
	})
}

describe('capability profile honesty vs headless xterm (CSI family)', () => {
	test('DA1 reply matches the profile', async () => {
		expect(await ask(new Terminal(), '\x1b[c')).toBe(CAPABILITY_PROFILE.da1)
	})

	test('DECRPM initial states match for tracked modes', async () => {
		for (const mode of [2004, 2026, 1016]) {
			const reply = await ask(new Terminal(), `\x1b[?${mode}$p`)
			expect(reply).toBe(`\x1b[?${mode};${CAPABILITY_PROFILE.modes[mode]}$y`)
		}
	})

	test('DECSET transition: xterm reports set(1) after ?2004h, matching tracked answers', async () => {
		const term = new Terminal()
		term.write('\x1b[?2004h')
		expect(await ask(term, '\x1b[?2004$p')).toBe('\x1b[?2004;1$y')
	})

	test('headless xterm version matches the client xterm version range', () => {
		const contracts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
		const client = JSON.parse(readFileSync(new URL('../../client/package.json', import.meta.url), 'utf8'))
		expect(contracts.devDependencies['@xterm/headless']).toBe(client.dependencies['@xterm/xterm'])
	})
})
