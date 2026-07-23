// spawnSpecFor — the per-session backend selector runConnector feeds to
// ConnectorSessionManager: 'tmux' → canvasTmuxSpawnSpec (legacy, unchanged);
// 'pty' → canvasShellSpawnSpec (connector-owned PTY, EW Codespaces §6.1).
// Pure: asserts on the returned SpawnSpec, spawns nothing.
// Run with: bun src/connector/spawn-spec.test.ts
import assert from 'node:assert/strict'
import { spawnSpecFor } from './index.ts'

const env = { HOME: '/home/u', SHELL: '/bin/zsh' } as NodeJS.ProcessEnv

// tmux backend: the existing canvas tmux policy, session name derived from id.
{
	const spec = spawnSpecFor('tmux', 'abc', env)
	assert.equal(spec.file, 'tmux')
	assert.ok(spec.args.includes('canvas-abc'), 'tmux session name carries the canvas- prefix + session id')
	assert.equal(spec.cwd, '/home/u')
}

// pty backend: the user's login shell, no tmux anywhere, id-independent.
{
	const spec = spawnSpecFor('pty', 'abc', env)
	assert.equal(spec.file, '/bin/zsh', 'shell comes from env.SHELL')
	assert.deepEqual(spec.args, ['-l'], 'login shell, no tmux args')
	assert.equal(spec.cwd, '/home/u')
	assert.ok(!spec.args.includes('abc'), 'raw shell has no session-name arg')
}

// SP4 cwd passthrough: a seeded cwd overrides HOME for the spawned shell/tmux;
// no cwd → the existing HOME default.
{
	const spec = spawnSpecFor('pty', 'abc', env, '/workspaces/repo/sub')
	assert.equal(spec.cwd, '/workspaces/repo/sub', 'seeded cwd wins for the pty backend')
	const tmuxSpec = spawnSpecFor('tmux', 'abc', env, '/workspaces/repo/sub')
	assert.equal(tmuxSpec.cwd, '/workspaces/repo/sub', 'seeded cwd wins for tmux too')
	assert.equal(spawnSpecFor('pty', 'abc', env).cwd, '/home/u', 'no seed → HOME default unchanged')
}

console.log('ok: spawnSpecFor — tmux vs pty spawn policy selection, seeded-cwd override')
