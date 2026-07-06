# Attribution — stamp who wrote, server-side, from `Whoami`

**Phase 3, sub-project 3c-attribution.** The mutating canvas routes
(`/api/canvas/sticky`, `/api/canvas/shape`, `/api/roadmap/doc` POST) stop
trusting the caller for authorship. The server resolves the caller's identity
with `resolveCaller` (the auth plane, already merged) and, through **one shared
helper**, stamps a structured `meta.author` and renders the visible
`🤖 <identity>: ` badge on the text — for **credentialed** callers only. A new
optional `body.author` field replaces the prefix-baked-into-text convention on
the wire; it is honoured only on anonymous / "none" instances and is **ignored
whenever a credential exists**.

Conforms to the plugin-architecture track charter
(`2026-07-06-plugin-architecture-track-charter.md`) §"3c — Attribution (the
pinned bundle)", which is the constitution for this slice, and to
`unified-architecture-design.md` §6.4 (auth & attribution). House style follows
`2026-07-06-tool-manifest-design.md`.

## Scope boundary — what 3c-attribution is and is not

3c-attribution **is** the write-time attribution stamp: caller → `Whoami` →
`{ metaAuthor, display }` → structured shape/doc meta + a badged text prefix,
applied uniformly across the three content-write routes through a single helper.

It is **not**:

- **A read-surface change.** `GET /api/canvas/frame` / `frames` /
  `roadmap read` return exactly what they return today. `meta.author` lands in
  the persisted record (and syncs to clients over the tldraw socket), but no
  read handler is taught to *project* it in this slice. Surfacing author in
  reads is a later, additive concern.
- **A backfill.** Existing stickies, shapes, and roadmap docs are untouched.
  Only writes that land *after* this slice carry `meta.author`. (Charter: "No
  backfill of existing records.")
- **A client render change.** No `client/` code changes. The browser already
  renders whatever text the record holds; the badge is just part of that text.
  A dedicated author chip in the tldraw UI is out of scope.
- **A `must-match` authz class.** A credentialed caller who also sends
  `body.author` is not 4xx'd; the field is silently ignored (charter: "No
  must-match 4xx class"). `body.author` only ever *adds* a cosmetic label on
  anonymous instances.
- **A transcript/scribe change.** The charter pins the shared helper to
  "sticky, shape, roadmap". `POST /api/scribe/transcript` already carries its
  own speaker `identity`/`name` fields and is out of this bundle.
- **A write-guard change.** `createWriteScopeGuard` (read-only → 403) is
  untouched; attribution runs *inside* each handler, after the guard has
  already let the write through.

## Background

Today authorship is a **client-side convention with zero server involvement**.
`bin/canvas`'s `cmd_sticky` does the stamping itself
(`server/src/features/sticky.ts` never reads an author):

```bash
# bin/canvas, cmd_sticky — the convention this slice retires
if [[ -n "$author" ]]; then
  text="🤖 ${author}: ${text}"
  [[ -n "$color" ]] || color='light-blue'
fi
```

The prefix is baked into `body.text` on the wire; the server stores it
verbatim. Any caller can claim any author, and the identity the CLI passes
(`--author codespace-3`) is unrelated to the credential the request actually
carries. Meanwhile the auth plane already resolves the *real* caller:

```ts
// server/src/whoami.ts (merged)
resolveCaller(headers) → Whoami { identity: string|null, kind: 'human'|'bot'|'anonymous', via: 'sso'|'service-token'|'none' }
```

- **Human** (CF Access SSO): `identity = name ?? email`, `kind: 'human'`.
- **Bot** (CF Access service token): `identity` is the mapped display name from
  `service-tokens.toml`, `kind: 'bot'`. **These identities already carry their
  own `🤖` badge** — the config/tests spell them `"🤖 ro"`, `"🤖 codespace-3"`
  (see `write-scope.test.ts` and `unified-architecture-design.md` §6.4's
  `hosts.toml`). This is load-bearing for the badge-rendering rule below.
- **Anonymous** (`via: 'none'`): `identity = null`.

There is already **one server-stamped-authorship precedent** — the roadmap
handler overwrites the client's `data.meta.updated` with a server value and
comments the intent:

```ts
// server/src/features/roadmap.ts
data.meta.updated = updated // server-stamped; client-supplied values are ignored
```

3c-attribution generalises exactly that stance to *who*, across all three
routes, sourced from `Whoami` instead of a wall-clock date.

**Why these routes are safe to badge as an agent surface.** Real human canvas
edits never reach these HTTP routes. The browser mutates shapes over the tldraw
sync WebSocket — `server.on('upgrade')` routes `/sync/:roomId` to a
`TLSocketRoom` (`app.ts` lines 145–172), a CRDT channel with no `/api/canvas/*`
involvement. The `POST /api/canvas/*` and `POST /api/roadmap/doc` routes are the
**agent / CLI surface** (`bin/canvas`, the future `ensembleworks` CLI, `curl`).
A caller reaching them with a *human* SSO credential is a human **scripting**
the canvas, not clicking on it — so a `🤖`-badged, server-attributed write is
correct there and **cannot double-stamp a UI edit**, because UI edits are on a
different channel entirely.

## Goal

- A shared, network-free `server/src/kernel/attribution.ts` exposing
  `resolveAttribution(caller, bodyAuthor)` and `badgeText(text, display)`.
- `features/sticky.ts`, `features/shape.ts` (create op), and
  `features/roadmap.ts` each resolve the caller and apply the helper — the note
  / shape / roadmap-doc carries `meta.author`, and sticky/shape text carries the
  `🤖 <name>: ` badge.
- The three mutating tool defs (`canvasSticky`, `canvasShape`, `roadmapWrite`)
  gain an optional `author` field in `zodInput` — the def travels with the
  route (3b spec R5). The bidirectional completeness test in
  `tools-api.test.ts` stays green (paths/methods unchanged; verb count still 15).
- `bin/canvas`'s `cmd_sticky` stops client-side prefixing and sends
  `body.author` instead (it must keep working until #4 retires it).
- `bun run typecheck`, `bun run build`, `bun run test` green. **Suite count:
  43 → 45** (this slice adds exactly two suites; see Testing).

## The attribution semantics (settled, per caller class)

The whole slice reduces to this table. `caller` is the `Whoami` from
`resolveCaller`; `body.author` is the new optional field.

| caller | `caller.identity` | `body.author` | structured `meta.author` | visible badge | notes |
|---|---|---|---|---|---|
| Bot (service token) | `"🤖 codespace-3"` | ignored | `"🤖 codespace-3"` | `🤖 codespace-3: ` | authoritative; `body.author` discarded |
| Human (SSO, via CLI/curl) | `"Alice"` (name/email) | ignored | `"Alice"` | `🤖 Alice: ` | agent surface — see Background |
| Anonymous + voluntary author | `null` | `"dave"` | **none** (unset) | `🤖 dave: ` | "none"-instance pass-through: cosmetic only, never structured |
| Anonymous, no author | `null` | absent | **none** | none | stamp nothing; never fabricate `anonymous`/`dev` |

Three rules encode it:

1. **Credential wins, always.** If `caller.identity !== null` the write is
   attributed to `caller.identity` and `body.author` is **ignored** — no
   comparison, no 4xx (charter). Structured `meta.author` *and* the badge both
   use `caller.identity`.
2. **Anonymous author is cosmetic only.** If `caller.identity === null` a
   non-empty `body.author` produces the **visible badge only** — never a
   structured `meta.author`. Structured attribution is a claim of *verified*
   authorship; a "none" instance's self-asserted label must not be forgeable
   into `meta.author` (an anonymous caller could otherwise stamp
   `meta.author: "🤖 codespace-3"`). This is the faithful reading of "anonymous
   /dev writes stamp nothing" + "'none' instances keep the voluntary `--author`
   pass-through unchanged": pass-through == the old cosmetic text prefix, no
   more.
3. **Never fabricate.** Anonymous with no `body.author` stamps nothing — no
   badge, no `meta.author`, no `"anonymous"`/`"dev"` literal.

Two clarifying notes on the caller classes:

- **A dev identity is a credential.** A box configured with
  `EW_DEV_IDENTITY_EMAIL` resolves through `getAccessIdentity` as a real
  identity (`kind: 'human'`, `via: 'sso'`, `identity !== null`) and stamps
  exactly like an SSO human — the "anonymous/dev writes stamp nothing" clause
  applies only to the null-identity default, not to a dev instance that has
  opted into a named dev identity.
- **The "none-instance" qualifier is deployment posture, not a server branch.**
  `resolveAttribution` gates the voluntary cosmetic badge on
  `caller.identity === null`, *not* on `accessVerificationEnabled()`. On a
  strict (verified) instance anonymous callers are blocked at the edge by CF
  Access, so the anonymous branch is unreachable there — an explicit
  `strict && anonymous → drop author` server branch would be dead code. The
  charter's "'none' instances keep the voluntary pass-through" is guaranteed by
  where anonymous requests can *arrive*, not by an extra conditional.

### What this slice does and does not prove to a viewer

Be honest about the trust signal 3c ships: the durable, trustworthy field
(`meta.author`, credential-only) is **not projected into any read or UI
surface in this slice**, and the visible `🤖 <name>: ` badge **is forgeable**
by a voluntary `body.author` on a "none" instance. So 3c ships **no
human-visible trust distinction** — a viewer cannot yet tell a
credential-stamped badge from a voluntary one by looking at the canvas. The
distinction becomes visible when a later slice renders an author chip from
`meta.author` (see R4). This is not a regression: today's client-side
prefixing is *entirely* forgeable and stores nothing structured; 3c makes the
trustworthy record exist without yet claiming to display it. Relatedly,
`meta.author` is exactly as trustworthy as the deployment's auth mode: in
header-trust mode the identity rests on the same tunnel trust basis as the
`Cf-Access-…-Email` header (per the auth plane's docblock in
`server/src/whoami.ts`); only verified mode makes it cryptographically checked.

### Badge rendering — exactly one `🤖`

The visible prefix is `🤖 <bare-name>: `, where `<bare-name>` is the display
name with any **leading `🤖` stripped first**. This is the settled resolution of
a genuine conflict in the source material: the charter writes the badge
literally as `🤖 <identity>:`, but bot identities *already* contain `🤖`
(`"🤖 codespace-3"`), so a blind `` `🤖 ${identity}: ` `` yields the absurd
`🤖 🤖 codespace-3:`. Stripping-then-prepending guarantees **exactly one badge**
in every case:

- bot `"🤖 codespace-3"` → `🤖 codespace-3: ` (matches the charter's rendered form
  and today's `bin/canvas` output byte-for-byte),
- human `"Alice"` → `🤖 Alice: `,
- anonymous voluntary `"dave"` → `🤖 dave: `.

This is a rendering detail *within* the bundle (how the pinned badge composes),
not a product decision, so it is settled here rather than escalated.

**No badge on empty text.** `badgeText` also no-ops when the *text* is empty or
whitespace. This matters for `POST /api/canvas/shape`: geo and arrow shapes are
legal without a label (`shape.ts` builds `toRichText(text ?? '')`), and badging
`''` would render a floating, orphaned `🤖 name: ` label on an otherwise
label-less shape. The structured `meta.author` **still stamps** on such shapes
— the badge is display chrome for text that exists; attribution is not.

`meta.author` (the structured value) is stored **verbatim** — the full
`caller.identity`, `🤖` and all — because it is the machine-readable identity,
not display chrome.

### Where the stamp lands, per store

| route | structured author sink | badge sink | when |
|---|---|---|---|
| `POST /api/canvas/sticky` | the note shape's `meta.author` | `props.richText` (via `toRichText(badgeText(...))`) | on the (only) create |
| `POST /api/canvas/shape` | the created shape's `meta.author` (`base.meta`) | `props.richText` of the created geo/text/note/arrow — **only when the shape has non-empty text** (label-less geo/arrow: `meta.author` only, no badge) | **create op only** |
| `POST /api/roadmap/doc` | `data.meta.author` (doc-level, beside `data.meta.updated`) | — (roadmap has no free-text body to badge) | every write (replace/set/move batch) |

Rationale for the per-store timing:

- **Sticky / shape stamp the *creator*, on create only.** Sticky POST always
  creates. Shape `update`/`delete` do **not** re-attribute: the author is who
  made the shape; re-badging on every edit would double the prefix and churn
  authorship on unrelated field tweaks. (`update`/`delete` still pass the
  write-scope guard exactly as before.)
- **Roadmap stamps the *last writer*, every write.** This mirrors the existing
  `data.meta.updated` precedent — the roadmap doc carries "last updated (date)"
  and now "last updated by". `set`/`move` ops mutate an existing doc; the
  doc-level author reflects whoever last touched it, which is the only
  attribution granularity roadmap has (ops are not individually authored — that
  is Phase-4+ territory, explicitly not opened here). tldraw shape `meta` is a
  free-form `JsonObject`, and `validateRoadmap` only *requires* `meta.title`
  (it does not reject extra `meta` keys), so both sinks accept `author` with no
  schema fight.

### Idempotency / trusting the wire post-cutover

The server does **not** scan `body.text` for a pre-existing `🤖 …: ` prefix and
strip it. Post-cutover the contract is: callers send **clean text** and use
`body.author` (`bin/canvas` is edited to do exactly this; #4's CLI inherits the
contract). The only idempotency guarantee is on the **identity string** —
`badgeText` never doubles the `🤖` on the name. A caller who perversely sends
both a `🤖`-prefixed `body.text` *and* an author gets a double prefix; that is
caller error, not a case the server defends against (matching the existing
"garbage in `body.props` → 400" trust model in `shape.ts`).

## Code

### `server/src/kernel/attribution.ts` (the shared helper — full)

```ts
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
```

### `server/src/features/sticky.ts` (the fully-worked handler integration)

Diff against the current handler — two imports, one `resolveCaller` call, the
`text` becomes badged, and the note record gains a `meta`:

```ts
import { canvasSticky } from '@ensembleworks/contracts'
import { createShapeId, toRichText } from '@tldraw/tlschema'
// … existing imports …
import { badgeText, resolveAttribution } from '../kernel/attribution.ts'
import { resolveCaller } from '../whoami.ts'

	router.post(canvasSticky.http.path, async (req, res) => {
		const body = (req.body ?? {}) as Record<string, unknown>
		const roomId = sanitizeId(String(body.room ?? 'team'))
		const text = typeof body.text === 'string' ? body.text.trim() : ''
		const frame = typeof body.frame === 'string' ? body.frame : null
		const color = typeof body.color === 'string' ? body.color : 'yellow'
		if (!roomId) return void res.status(400).json({ error: 'bad room id' })
		if (!text || text.length > 2000) {
			return void res.status(400).json({ error: 'text must be non-empty and at most 2000 chars' })
		}
		if (!NOTE_COLORS.includes(color)) {
			return void res.status(400).json({ error: `color must be one of ${NOTE_COLORS.join(' | ')}` })
		}

		// Attribution: stamp the real caller (credential wins; anonymous body.author
		// is a cosmetic badge only). Resolved once, before the store transaction.
		const attribution = resolveAttribution(await resolveCaller(req.headers), body.author)
		const badged = badgeText(text, attribution.display)

		let createdId: string | null = null
		let frameFound = true
		await ctx.rooms.getOrCreateRoom(roomId).updateStore((store) => {
			// … unchanged parent/grid/index resolution …
			const id = createShapeId()
			const note = (schema.types.shape as any).create({
				id,
				type: 'note',
				parentId,
				index: getIndexAbove(topIndex),
				x,
				y,
				meta: attribution.metaAuthor ? { author: attribution.metaAuthor } : {},
				props: {
					richText: toRichText(badged),   // was: toRichText(text)
					color,
					// … all other props unchanged …
				},
			})
			store.put(note)
			createdId = id
		})
		if (!frameFound) return void res.status(404).json({ error: 'frame not found' })
		res.json({ ok: true, id: createdId })
	})
```

Note the length check runs on the **pre-badge** `text` (the caller's own 2000-char
budget is not eaten by the server's badge — the badge is server chrome). The
`{ ok, id }` response shape is unchanged, so `canvasSticky.zodOutput` needs no
edit.

### `server/src/features/shape.ts` (create op)

Same shape: resolve `attribution` once at the top of the handler
(`const attribution = resolveAttribution(await resolveCaller(req.headers), body.author)`),
then in the **create** branch (a) compute the badged text once —
`const badged = badgeText(text ?? '', attribution.display)` — and pass it
wherever the branch currently passes `text` to `toRichText` (geo/arrow use
`toRichText(badged)` in place of `toRichText(text ?? '')`; text/note, which
require text, use `toRichText(badged)` in place of `toRichText(text)`), and
(b) set `base.meta` from
`attribution.metaAuthor ? { author: attribution.metaAuthor } : {}` (it is `{}`
today). Because `badgeText` no-ops on empty text, a label-less geo or arrow
gets **no** floating `🤖 name: ` label — it carries `meta.author` only. The
`delete` and `update` branches are untouched — they do not attribute (see
per-store timing).

### `server/src/features/roadmap.ts` (doc-level author)

Beside the existing server-stamp of `updated`, add the author stamp (credential
only — for an anonymous "none" write, `metaAuthor` is null and roadmap has no
cosmetic text surface, so nothing is stamped):

```ts
const attribution = resolveAttribution(await resolveCaller(req.headers), body.author)
// … existing applyOps / rev / updated logic …
data.meta.updated = updated // server-stamped; client-supplied values are ignored
if (attribution.metaAuthor) data.meta.author = attribution.metaAuthor // server-stamped, like `updated`
```

`server/src/roadmap-store.ts`'s `RoadmapDoc` interface gains the field so
TypeScript accepts the assignment:

```ts
export interface RoadmapDoc {
	meta: { title: string; revision?: string; updated?: string; author?: string }
	outcomes: RoadmapOutcome[]
}
```

`validateRoadmap` already ignores unknown `meta` keys, so no validator change.

### `contracts/src/tools/{canvas,roadmap}.ts` (the def travels with the route)

Add one optional field to each mutating def's `zodInput` (3b spec R5). Example
for `canvasSticky`:

```ts
	zodInput: z.object({
		room,
		text: z.string().min(1).max(2000).describe('sticky body; trimmed, 1–2000 chars'),
		frame: z.string().optional().describe('fuzzy (case-insensitive substring) frame name'),
		color: z.enum(NOTE_COLORS as [string, ...string[]]).optional().describe('defaults to yellow server-side'),
		author: z.string().optional().describe('voluntary display name; honoured only on anonymous/"none" instances — ignored when the caller is credentialed'),
	}),
```

The identical `author` line is added to `canvasShape.zodInput`. On
`roadmapWrite.zodInput` the field is declared for wire-shape uniformity but is
**inert** — roadmap has no cosmetic text surface to badge and `meta.author` is
credential-only — so its describe string must say so, lest the manifest
mislead a CLI user into thinking `--author` labels an anonymous roadmap write:

```ts
		author: z.string().optional().describe('accepted for wire-shape uniformity but currently inert: ignored when the caller is credentialed, and roadmap has no cosmetic badge surface for anonymous authors'),
```

`z.toJSONSchema` handles an optional string trivially,
so `tools.test.ts`'s per-def serialisation guard stays green; verb count is
still 15 and no `(method, path)` changes, so `tools-api.test.ts`'s bidirectional
completeness test stays green.

### `bin/canvas` (`cmd_sticky` — stop prefixing, send `body.author`)

The client-side badge block is removed; `--author` becomes a wire field, and the
light-blue default is preserved (a nicety agents rely on):

```bash
  # Author is now a wire field: the server stamps the 🤖 badge and meta.author
  # from the request's credential. On a "none" instance --author still shows as a
  # cosmetic badge. Keep the light-blue default so agent stickies stand out.
  if [[ -n "$author" ]]; then
    [[ -n "$color" ]] || color='light-blue'
  fi
  # … existing trim / length / colour validation on the RAW text …

  local payload
  payload="$(printf '{"room":"%s","text":"%s"' \
    "$(json_escape "$canvas_room")" "$(json_escape "$text")")"
  [[ -n "$frame" ]]  && payload+="$(printf ',"frame":"%s"'  "$(json_escape "$frame")")"
  [[ -n "$color" ]]  && payload+="$(printf ',"color":"%s"'  "$color")"
  [[ -n "$author" ]] && payload+="$(printf ',"author":"%s"' "$(json_escape "$author")")"
  payload+='}'
```

The `--help` text's "`--author` prefixes the text with `🤖 <name>: `" line is
reworded to "sends the author to the server, which stamps the badge". `bin/canvas`
keeps working end-to-end against the new server until #4 retires it.

## Data flow

```
agent / CLI                                server (:8788 kernel)
──────────                                 ─────────────────────
POST /api/canvas/sticky                     createWriteScopeGuard  (403 iff read-only token)
  { room, text, author? }  ───────────────► features/sticky.ts
  + Cf-Access-* credential headers            resolveCaller(headers) → Whoami
                                              resolveAttribution(caller, body.author)
                                                → { metaAuthor, display }
                                              note.props.richText = toRichText(badgeText(text, display))
                                              note.meta = metaAuthor ? { author: metaAuthor } : {}
  ◄──────────────── { ok, id } ─────────────
```

The credential the *request already carries* drives attribution; the caller's
own `author` claim is consulted only when there is no credential.

## Testing

**Suite count: 43 → 45.** Two new self-running `*.test.ts` suites (house
convention: `bun src/<x>.test.ts`, ending `console.log('ok: …')`, discovered by
`scripts/run-tests.ts`). No existing suite changes: sticky/shape/roadmap
response *shapes* are unchanged, so `canvas-api.test.ts` / `roadmap-api.test.ts`
stay green (their assertions are on status + `{ ok, id }` / rev, not on note
text — the one text assertion in `canvas-api.test.ts` seeds its note directly
via `updateStore`, not through the badged POST path). `tools-api.test.ts` and
`tools.test.ts` stay green (optional field only). The bin/canvas edit is covered
by the api suite's anonymous-with-author case, which exercises the exact wire
shape bin/canvas now sends.

### 1. `server/src/attribution.test.ts` — helper unit test (network-free)

Pure `resolveAttribution` + `badgeText`, no server boot. Builds `Whoami` values
by hand:

- **Credential wins:** `resolveAttribution({identity:'🤖 rw',kind:'bot',via:'service-token'}, 'forged')`
  → `{ metaAuthor: '🤖 rw', display: '🤖 rw' }` (body ignored).
- **Human credential:** `resolveAttribution({identity:'Alice',kind:'human',via:'sso'}, undefined)`
  → `{ metaAuthor: 'Alice', display: 'Alice' }`.
- **Anonymous + voluntary:** `resolveAttribution({identity:null,kind:'anonymous',via:'none'}, 'dave')`
  → `{ metaAuthor: null, display: 'dave' }` (cosmetic only, no structured author).
- **Anonymous, no author:** same caller, `undefined` / `''` / `'   '`
  → `{ metaAuthor: null, display: null }` (stamp nothing).
- **`badgeText` single-badge:** `badgeText('hi','🤖 codespace-3')` === `'🤖 codespace-3: hi'`
  (no double `🤖`); `badgeText('hi','Alice')` === `'🤖 Alice: hi'`;
  `badgeText('hi', null)` === `'hi'`.
- **`badgeText` empty-text no-op:** `badgeText('', '🤖 rw')` === `''` and
  `badgeText('   ', '🤖 rw')` === `'   '` — no floating `🤖 rw: ` orphan on a
  label-less shape (the shape still gets `meta.author`; that is pinned by the
  api suite's label-less-geo case).

### 2. `server/src/attribution-api.test.ts` — booted-app, header-trust JWTs

Reuses the write-scope-api pattern exactly: `createSyncApp({ dataDir })` on an
ephemeral port, a temp `service-tokens.toml` with a `read-write` token
`"🤖 rw"`, header-trust mode (`delete CF_ACCESS_TEAM_DOMAIN/AUD`, unsigned
`alg:none` JWT carrying `common_name`). After each `POST /api/canvas/sticky`,
the created note is read back **directly from the store** — `getOrCreateRoom('team')`
+ an `updateStore` that captures `store.getAll()`, finding the newest `type:'note'`
record — and its `meta.author` and `richTextToPlainText(props.richText)` are
asserted (mechanism verified against `canvas-api.test.ts`, which reads notes
back the same way, and `write-scope-api.test.ts`'s JWT helper):

- **Bot token → structured + badge:** post `{room:'team',text:'ship it'}` with
  `Cf-Access-Jwt-Assertion: jwt({common_name:'rw.access'})` → note `meta.author === '🤖 rw'`,
  text `=== '🤖 rw: ship it'` (single badge — the identity's own `🤖` is not doubled).
- **Bot token IGNORES body.author:** post `{…,text:'x',author:'somebody-else'}`
  with the same token → note `meta.author === '🤖 rw'`, text `=== '🤖 rw: x'`
  (the forged author never appears).
- **Anonymous + voluntary author → badge only:** post `{…,text:'note',author:'dave'}`
  with **no** credential headers → text `=== '🤖 dave: note'`, and
  `meta.author` is **absent** (`meta` has no `author` key).
- **Anonymous, no author → nothing:** post `{…,text:'plain'}` no headers →
  text `=== 'plain'`, no `meta.author`.
- **Label-less shape → meta only, no orphan badge:** `POST /api/canvas/shape`
  `{room:'team',type:'geo'}` (no `text`) with the `rw.access` token → the
  created geo's `meta.author === '🤖 rw'` and
  `richTextToPlainText(props.richText) === ''` (no floating `🤖 rw: ` label).
- **Roadmap doc-level author:** `POST /api/roadmap/doc` a `replace` batch with the
  `rw.access` token, then `GET /api/roadmap/doc?...&name=…` → `data.meta.author === '🤖 rw'`;
  the same write anonymous → `data.meta.author` absent.

### Manual smoke

`bin/dev up`; then with a read-write service token configured:
`ENSEMBLEWORKS_TOKEN_ID/_SECRET=… bin/canvas sticky 'hello' --frame Advice` →
the note renders `🤖 <bot-identity>: hello`, and
`bin/canvas read Advice | jq '.notes'` shows the badged text. Anonymous
`bin/canvas sticky 'hi' --author dave` on a "none" instance renders
`🤖 dave: hi` with no `meta.author` in the persisted record.

## Risks

- **R1 — double `🤖` on bot identities.** The literal charter badge
  `🤖 <identity>:` over an identity that already carries `🤖` yields `🤖 🤖 …`.
  Mitigated by `badgeText`'s strip-then-prepend (exactly one badge), pinned by
  the unit + api tests. This is the one place the spec resolves a charter-vs-code
  conflict; called out for auditability, not escalated (rendering detail, not a
  product choice).
- **R2 — forgeable structured author.** If anonymous `body.author` fed
  `meta.author`, a "none" caller could forge a trusted-looking author. Mitigated
  by rule 2: structured `meta.author` is credential-only; anonymous author is
  cosmetic. Pinned by the "anonymous + voluntary → badge only" api case.
- **R3 — two header decodes per write.** The write-scope guard already calls
  `resolveWriteScope`; the handler now also calls `resolveCaller`. Both decode
  the same header; in header-trust mode this is a cheap base64 decode, in
  verified mode the JWKS verification is cached. A `req`-attached caller
  middleware could dedupe it, but that is cross-cutting scope creep for a
  micro-cost; kept handler-local, matching the existing `whoami` route which
  calls `resolveCaller` directly. Flagged, not blocking.
- **R4 — `meta.author` visible to clients before a render exists.** The field
  syncs to browsers over the tldraw socket immediately, though no client renders
  it this slice. This is inert (unknown `meta` keys are ignored by the tldraw
  schema) and is the intended seam for a later author-chip; noted so the later
  slice knows the data is already flowing.
- **R5 — update/delete not attributed.** A shape's author reflects its creator,
  not its last editor. Deliberate (see per-store timing); if per-edit
  attribution is ever wanted it is an additive, separate decision — not silently
  in scope here.
