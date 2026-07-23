/**
 * Repo/branch detection (decision #8): repo = basename of `git rev-parse
 * --show-toplevel`, branch = `git rev-parse --abbrev-ref HEAD`; a non-git dir
 * degrades to repo = basename(cwd), branch = ''. The realpath'd toplevel is
 * the codespaces.json key AND the devcontainer --workspace-folder.
 */
import { realpathSync } from 'node:fs'
import path from 'node:path'

export interface RepoInfo {
	/** realpath of the workspace folder (git toplevel, or cwd when not a repo) */
	toplevel: string
	repo: string
	branch: string
}

function git(args: string[], cwd: string): string | null {
	const res = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
	if (res.exitCode !== 0) return null
	return res.stdout.toString().trim()
}

export function detectRepoInfo(cwd: string): RepoInfo {
	const top = git(['rev-parse', '--show-toplevel'], cwd)
	if (!top) {
		const real = realpathSync(cwd)
		return { toplevel: real, repo: path.basename(real), branch: '' }
	}
	const real = realpathSync(top)
	// A freshly-initted repo with no commits errors here → '' (still bootable).
	const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd) ?? ''
	return { toplevel: real, repo: path.basename(real), branch }
}
