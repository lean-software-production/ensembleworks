/**
 * Storage geometry contract — the required DATA_DIR / DATABASE_DIR /
 * DATABASE_BACKUPS_DIR triple and the collision rules between them.
 *
 * Why this exists: the 2026-07-10 ew-lsp-001 outage. DATABASE_DIR was silently
 * unset, the sync server fell back to writing live room DBs into
 * DATA_DIR/rooms — the same directory the 15-minute backup timer mv -f's its
 * snapshots into — and the timer stamped a stale snapshot over the live, open
 * database (SQLITE_CORRUPT). The rules below make every known collision shape
 * a refused-to-start instead of a corrupted-in-15-minutes. The laingville
 * backup scripts enforce the same rules on their side before touching a file;
 * both sides read the triple from the per-box storage.env so they cannot
 * disagree. See docs/superpowers/specs/2026-07-11-required-database-dirs-design.md.
 *
 * Paths are compared after lexical normalization (path.resolve), not
 * realpath: the directories may not exist yet at validation time, and the
 * threat model is config typos, not adversarial symlinks.
 */
import path from 'node:path'

export interface StorageGeometry {
	dataDir: string
	databaseDir: string
	databaseBackupsDir: string
}

/** True when `child` is `parent` or lives underneath it (segment-aware: /a/bc is not inside /a/b). */
function within(child: string, parent: string): boolean {
	const rel = path.relative(parent, child)
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Read + validate the triple from an env map. Throws one Error naming every
 * violated rule (all of them, not just the first) so a misconfigured box's
 * journal shows the whole problem in one boot attempt.
 */
export function resolveStorageGeometry(env: Record<string, string | undefined>): StorageGeometry {
	const problems: string[] = []

	const missing = (['DATA_DIR', 'DATABASE_DIR', 'DATABASE_BACKUPS_DIR'] as const).filter(
		(k) => !env[k]?.trim(),
	)
	if (missing.length > 0) {
		throw new Error(
			`storage geometry: required env var(s) unset: ${missing.join(', ')} — ` +
				'all three are supplied by ~/.config/ensembleworks/storage.env in prod ' +
				'(see docs/superpowers/specs/2026-07-11-required-database-dirs-design.md)',
		)
	}

	const dataDir = path.resolve(env.DATA_DIR!.trim())
	const databaseDir = path.resolve(env.DATABASE_DIR!.trim())
	const databaseBackupsDir = path.resolve(env.DATABASE_BACKUPS_DIR!.trim())

	// Live DBs and their backup destination must never coincide or nest — a
	// backup run over a live, open DB is exactly the corruption incident.
	if (within(databaseDir, databaseBackupsDir) || within(databaseBackupsDir, databaseDir)) {
		problems.push(
			`DATABASE_DIR (${databaseDir}) and DATABASE_BACKUPS_DIR (${databaseBackupsDir}) coincide or nest`,
		)
	}
	// Live DBs must not sit inside the general data root (that was the
	// incident's geometry: rooms fell back into DATA_DIR where the timer
	// writes), and the data root must not sit inside the live-DB dir.
	if (within(databaseDir, dataDir) || within(dataDir, databaseDir)) {
		problems.push(`DATABASE_DIR (${databaseDir}) and DATA_DIR (${dataDir}) coincide or nest`)
	}
	// DATABASE_BACKUPS_DIR inside DATA_DIR is fine and expected (durable volume).

	if (problems.length > 0) {
		throw new Error(`storage geometry: refusing collision-shaped config:\n  - ${problems.join('\n  - ')}`)
	}
	return { dataDir, databaseDir, databaseBackupsDir }
}
