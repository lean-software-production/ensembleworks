// codespace group dispatch through the real main(): unknown verb → exit 2
// with the verb menu; `codespace list --json` works end-to-end against an
// empty isolated store (no conn needed); top help advertises the group.
// Network-free. Run with: bun src/codespace/group.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { main } from '../main.ts'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ew-group-'))
const env = { ...process.env, XDG_CONFIG_HOME: path.join(tmp, 'config') } as NodeJS.ProcessEnv

const captureStd = async (fn: () => Promise<number>) => {
	const out: string[] = []
	const err: string[] = []
	const realOut = process.stdout.write.bind(process.stdout)
	const realErr = process.stderr.write.bind(process.stderr)
	;(process.stdout as any).write = (s: string) => { out.push(String(s)); return true }
	;(process.stderr as any).write = (s: string) => { err.push(String(s)); return true }
	let code: number
	try {
		code = await fn()
	} finally {
		;(process.stdout as any).write = realOut
		;(process.stderr as any).write = realErr
	}
	return { code, out: out.join(''), err: err.join('') }
}

// Unknown verb → exit 2 + the menu.
{
	const r = await captureStd(() => main(['codespace', 'frobnicate'], env))
	assert.equal(r.code, 2)
	assert.match(r.err, /unknown codespace command: frobnicate .*up \| stop \| rebuild \| list \| reconcile \| boot-install/)
}
// No verb at all → same shape.
{
	const r = await captureStd(() => main(['codespace'], env))
	assert.equal(r.code, 2)
	assert.match(r.err, /unknown codespace command: \(none\) .*reconcile \| boot-install/)
}
// list --json against the empty isolated store: exit 0, `{}` on stdout.
{
	const r = await captureStd(() => main(['codespace', 'list', '--json'], env))
	assert.equal(r.code, 0)
	assert.deepEqual(JSON.parse(r.out), {}, 'empty store lists as {}')
}
// Top help advertises the group.
{
	const r = await captureStd(() => main([], env))
	assert.equal(r.code, 0)
	assert.match(r.out, /codespace up\|stop\|rebuild\|list/)
}

// reconcile dispatches: --dry-run against the empty store prints the empty plan.
{
	const r = await captureStd(() => main(['codespace', 'reconcile', '--dry-run'], env))
	assert.equal(r.code, 0)
	assert.deepEqual(JSON.parse(r.out), { targets: [], skipped: [] }, 'reconcile wired through dispatch')
}
// boot-install dispatches: --dry-run emits the unit plan (linux CI; the verb
// guard is platform-injected and covered in boot-install.test.ts).
if (process.platform === 'linux') {
	const r = await captureStd(() => main(['codespace', 'boot-install', '--dry-run'], env))
	assert.equal(r.code, 0)
	assert.ok(JSON.parse(r.out).unitText.includes('codespace reconcile'), 'boot-install wired through dispatch')
}

console.log('ok: codespace group — verb menu, list --json end-to-end, reconcile/boot-install dispatch, top help')
