// Repo/branch detection (decision #8) in a REAL temp git repo (branch named at
// init, one commit so HEAD resolves) and the non-git fallback. realpath both
// sides — os.tmpdir() is a symlink on some hosts.
// Run with: bun src/codespace/repo-info.test.ts
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detectRepoInfo } from './repo-info.ts'

const run = (argv: string[], cwd: string) => {
	const res = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe' })
	assert.equal(res.exitCode, 0, `${argv.join(' ')} failed: ${res.stderr.toString()}`)
}

// A git repo: repo = basename(toplevel), branch = current branch, toplevel
// detected from a SUBDIRECTORY (rev-parse walks up).
{
	const parent = mkdtempSync(path.join(os.tmpdir(), 'ew-repoinfo-'))
	const repoDir = path.join(parent, 'myrepo')
	mkdirSync(repoDir)
	run(['git', 'init', '-b', 'sp2-branch', repoDir], parent)
	run(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], repoDir)
	const sub = path.join(repoDir, 'deep', 'inside')
	mkdirSync(sub, { recursive: true })

	const info = detectRepoInfo(sub)
	assert.equal(info.toplevel, realpathSync(repoDir), 'toplevel is the realpath of the checkout root')
	assert.equal(info.repo, 'myrepo', 'repo = basename of toplevel')
	assert.equal(info.branch, 'sp2-branch')
}

// Non-git dir: repo = basename(cwd), branch = ''.
{
	const parent = mkdtempSync(path.join(os.tmpdir(), 'ew-repoinfo-plain-'))
	const plain = path.join(parent, 'notarepo')
	mkdirSync(plain)
	const info = detectRepoInfo(plain)
	assert.equal(info.toplevel, realpathSync(plain))
	assert.equal(info.repo, 'notarepo')
	assert.equal(info.branch, '', 'non-git dir has no branch')
}

console.log('ok: repo-info — git toplevel/branch from a subdir, non-git fallback')
