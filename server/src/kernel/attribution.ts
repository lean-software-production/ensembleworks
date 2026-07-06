/**
 * Write-time attribution for the canvas content routes (sticky, shape, roadmap).
 * Turns the resolved caller (Whoami) + an optional voluntary body.author into
 * what a write should stamp: a trusted structured `meta.author` (credential only)
 * and a cosmetic display name to badge free text with. See
 * docs/superpowers/specs/2026-07-06-attribution-design.md.
 */
import type { Whoami } from '@ensembleworks/contracts'

export interface Attribution {
	/** Trusted structured author for `meta.author`, or null to stamp none.
	 *  Set ONLY when the caller is credentialed (identity !== null). */
	metaAuthor: string | null
	/** Cosmetic display name to badge free text with, or null for no prefix. */
	display: string | null
}

/**
 * Resolve how to attribute a canvas write.
 *   - Credentialed (human via sso OR bot via service-token): authoritative;
 *     `bodyAuthor` is IGNORED; both structured author and badge use the identity.
 *   - Anonymous ("none"): a non-empty `bodyAuthor` is a COSMETIC badge only —
 *     never structured, never fabricated.
 */
export function resolveAttribution(caller: Whoami, bodyAuthor: unknown): Attribution {
	if (caller.identity !== null) {
		return { metaAuthor: caller.identity, display: caller.identity }
	}
	const voluntary =
		typeof bodyAuthor === 'string' && bodyAuthor.trim() ? bodyAuthor.trim() : null
	return { metaAuthor: null, display: voluntary }
}

/**
 * Prefix free text with a single `🤖 <name>: ` badge. Idempotent on the badge:
 * a `display` that already leads with `🤖` (every configured bot identity does)
 * is stripped first, so the result carries exactly one badge. No-ops on a
 * `null`/empty display AND on empty/whitespace text — a label-less shape
 * (geo/arrow with no text) must not render a floating `🤖 name: ` orphan;
 * `meta.author` still stamps regardless.
 */
export function badgeText(text: string, display: string | null): string {
	if (!display || !text.trim()) return text
	const bare = display.replace(/^🤖\s*/u, '')
	return `🤖 ${bare}: ${text}`
}
