/**
 * Backstop suppression: if a query somehow reaches a browser (responder
 * missed it / stale connector), xterm must not auto-reply. Also the OSC
 * colour oracle the headless honesty test cannot provide (headless xterm
 * has no colour manager).
 */
import { describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'

// `Terminal.paste()` needs a live textarea helper element, which only exists
// once the terminal is `.open()`-ed into a real DOM container — bun:test has
// no DOM by default, so happy-dom supplies one before @xterm/xterm loads.
const dom = new Window()
;(globalThis as unknown as { window: unknown }).window = dom
;(globalThis as unknown as { document: unknown }).document = dom.document
;(globalThis as unknown as { navigator: unknown }).navigator = dom.navigator

import { Terminal } from '@xterm/xterm'
import { registerTerminalIdentityHandlers } from '@ensembleworks/contracts/terminal-identity'

function opened(term: Terminal): Terminal {
	const container = dom.document.createElement('div')
	dom.document.body.appendChild(container)
	term.open(container as unknown as HTMLElement)
	return term
}

function collect(term: Terminal): string[] {
	const out: string[] = []
	term.onData((d) => out.push(d))
	return out
}
const write = (term: Terminal, s: string) => new Promise<void>((r) => term.write(s, r))

describe('registerTerminalIdentityHandlers', () => {
	test('suppresses DA1/DA2/DECRQM/kitty queries — no auto-reply', async () => {
		const term = new Terminal()
		registerTerminalIdentityHandlers(term)
		const out = collect(term)
		await write(term, '\x1b[c\x1b[>c\x1b[?2004$p\x1b[?u')
		await new Promise((r) => setTimeout(r, 20))
		expect(out).toEqual([])
	})

	test('unregistered terminal DOES auto-reply to DA1 (sanity: the suppression is doing something)', async () => {
		const term = new Terminal()
		const out = collect(term)
		await write(term, '\x1b[c')
		await new Promise((r) => setTimeout(r, 20))
		expect(out.join('')).not.toBe('')
	})

	test('DSR-5 suppressed but CPR (6n) still auto-replies — no final-R ambiguity introduced', async () => {
		const term = new Terminal()
		registerTerminalIdentityHandlers(term)
		const out = collect(term)
		await write(term, '\x1b[5n')
		await new Promise((r) => setTimeout(r, 20))
		expect(out).toEqual([])
		await write(term, '\x1b[6n')
		await new Promise((r) => setTimeout(r, 20))
		expect(out.join('')).toMatch(/^\x1b\[\d+;\d+R$/) // pty-backend CPR must flow
	})

	test('OSC 11 query suppressed; OSC 11 setter still applies (handler returns false)', async () => {
		const term = new Terminal()
		registerTerminalIdentityHandlers(term)
		const out = collect(term)
		await write(term, '\x1b]11;?\x1b\\') // query: suppressed
		await write(term, '\x1b]11;#1a1a2e\x1b\\') // setter: default handling
		await new Promise((r) => setTimeout(r, 20))
		expect(out).toEqual([])
	})

	test('bracketed paste survives: enabling 2004 and pasting still brackets', async () => {
		const term = opened(new Terminal())
		registerTerminalIdentityHandlers(term)
		const out = collect(term)
		await write(term, '\x1b[?2004h')
		term.paste('hello')
		expect(out.join('')).toBe('\x1b[200~hello\x1b[201~')
	})
})
