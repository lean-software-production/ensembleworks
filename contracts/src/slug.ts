/**
 * Roadmap-name slugification — the id under which a roadmap is stored and
 * fuzzily matched. Client (model.ts) and server (roadmap-store.ts) must
 * agree or pushes create duplicates.
 */
export function slugify(name: string): string | null {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64)
	return /^[a-z0-9][a-z0-9_-]*$/.test(slug) ? slug : null
}
