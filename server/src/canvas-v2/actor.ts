/**
 * DocumentActor — one Loro doc per room, wrapped around a SyncServerPeer,
 * persisted crash-recoverably to its own CanvasV2Store (Task C1). This is the
 * CORRECTED, durable-first design from the plan's "Amendments (2026-07-11,
 * post-review)" section — the original plan text (persisting only via
 * `peer.doc.subscribeLocalUpdates`) has a proven crash-consistency hole:
 * that hook fires exclusively for committed LOCAL ops, never for imports, and
 * every client edit arrives at the server as an import. Two client edits
 * through the original wiring produce ZERO append-log rows; a crash between
 * compactions loses all client work. See actor.test.ts's "hole-catcher" test,
 * which fails against that variant and passes against this one.
 *
 * BOTH persistence hooks feed one private persist():
 *  - `SyncServerOpts.onUpdatePayload` — fires synchronously with the raw
 *    inbound client Update payload, BEFORE repair/commit/relay (see
 *    server-peer.ts's JSDoc: "persist and relay exactly the frames that may
 *    carry ops we don't durably hold"). This is the leg the original design
 *    was missing entirely.
 *  - `peer.doc.subscribeLocalUpdates` — fires for genuinely local ops that
 *    never pass through onUpdatePayload: the server's own repair deltas
 *    (produced by SyncServerPeer.onFrame's `doc.repair(); doc.commit()` after
 *    a changed import) and direct agent writes to `actor.peer.doc`.
 * Neither hook alone covers both directions; both are required.
 *
 * LOAD PATH: replay snapshot + updates, commit() once, THEN run
 * `repair(); commit()` ONE more time before serving. The log may end
 * mid-merge — a crash can land after a client edit's raw payload was
 * appended (via onUpdatePayload) but before the resulting repair delta was
 * appended (via subscribeLocalUpdates), leaving a converged-but-unrepaired
 * state on disk. Recomputing repair here is safe and idempotent: repair is a
 * pure function of the converged model (canvas-model's repairPlan), so it
 * reconstructs exactly the delta that would have been persisted, or is a
 * no-op if nothing was actually lost.
 *
 * PEER-ID PROBE + DECISION (see execution report for the full script/output):
 * a fixed server peerId (opts.peerId, expected 1n per process) is SAFE to
 * reuse verbatim across a crash + restart. The danger scenario: a repair
 * delta is broadcast to a surviving client but the crash happens before its
 * `subscribeLocalUpdates` append lands; the reloaded actor's load-path repair
 * REGENERATES an op in the same peer/counter range. Probed directly against
 * loro-crdt 1.13.6: with `setRecordTimestamp` at its default (false — no
 * wall-clock enters committed ops) and repair being a pure function of the
 * (byte-identical, because the preceding history is byte-identical) converged
 * model, the regenerated delta is BYTE-IDENTICAL to the lost original, and
 * cross-importing either copy into a doc already holding the other reports
 * `{changed: false, pending: false}` — a clean no-op, not a collision. No
 * incarnation-counter mitigation is needed; peerId reuse ships as originally
 * planned.
 */
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import { SyncServerPeer, type Transport } from '@ensembleworks/canvas-sync'
import { CanvasV2Store } from './store.ts'

export interface ActorOpts {
	dir: string
	roomId: string
	peerId: bigint
	/** Compact after this many persisted updates since the last compaction. Default 500. */
	compactEvery?: number
}

export class DocumentActor {
	readonly peer: SyncServerPeer
	private store: CanvasV2Store
	private roomId: string
	private sinceCompaction = 0
	private compactEvery: number
	private closed = false
	private _tainted: Error | null = null
	private unsubPersist!: () => void

	/** Non-null once a persist failed: durability is lost, the peer has been
	 * closed, and connect() refuses. Read by the C3 registry (evict/replace)
	 * and the D3 metrics endpoint. Never resets on a live actor — recovery is
	 * a NEW DocumentActor on the same dir (it reloads the durable prefix). */
	get tainted(): Error | null {
		return this._tainted
	}

	constructor(opts: ActorOpts) {
		this.store = new CanvasV2Store(opts.dir, opts.roomId)
		this.roomId = opts.roomId
		this.compactEvery = opts.compactEvery ?? 500

		// Everything below opens the SQLite handle already held by `this.store`
		// (load/replay/repair can throw on a corrupt log; SyncServerPeer's own
		// construction cannot realistically throw but is included for the same
		// reason). A throw here must not leak that fd: the registry (C3) treats
		// "constructor threw" as "try the next room again later", so if we don't
		// close it ourselves nobody ever will, and every retried construction
		// leaks one more handle. Close-then-rethrow keeps a failed construction
		// exception-safe: the caller sees the original error, the fd is gone.
		try {
			// --- Load: snapshot + replay updates, then repair once (see class doc). ---
			const { snapshot, updates } = this.store.load()
			const doc = snapshot
				? LoroCanvasDoc.fromSnapshot(snapshot, { peerId: opts.peerId })
				: LoroCanvasDoc.create({ peerId: opts.peerId })
			for (const u of updates) doc.import(u)
			doc.commit()
			// Reconstruct any repair delta lost in the crash micro-window. Repair is
			// deterministic — this is a no-op if nothing was actually lost, and
			// correct (byte-for-byte, per the peer-id probe above) if something was.
			doc.repair()
			doc.commit()

			// --- Build the peer around the recovered doc. ---
			this.peer = new SyncServerPeer({
				peerId: opts.peerId,
				initialSnapshot: doc.exportSnapshot(),
				// Durable-first: client-sourced ops (imports), persisted BEFORE the
				// peer's own repair/commit/relay — see SyncServerOpts.onUpdatePayload's
				// JSDoc for exactly which frames fire this and why (pending payloads
				// included: they're cached nowhere else durable).
				onUpdatePayload: (payload) => this.persist(payload),
			})
			// Server-local ops: repair deltas (from the peer's own onFrame handling)
			// and direct agent writes to `this.peer.doc`. These never pass through
			// onUpdatePayload (that hook only sees inbound client frames), so this
			// second leg is required to durably capture them. The unsub is kept so
			// close() can release it — the peer's close() only detaches the PEER's
			// own subscription, not this one, and a post-close agent write must not
			// fire persist into a closed store.
			this.unsubPersist = this.peer.doc.subscribeLocalUpdates((bytes) => this.persist(bytes))
		} catch (err) {
			this.store.close()
			throw err
		}
	}

	/** The single append point both persistence hooks feed. */
	private persist(bytes: Uint8Array): void {
		// Once durability is lost, NEVER append again: Loro ops are causally
		// chained per peer, so an op logged after a lost one recovers as
		// pending-forever (its causal parent is missing). Dropping keeps the
		// on-disk log a valid durable prefix that recovery can always load.
		if (this._tainted) return
		try {
			// CanvasV2Store.appendUpdate copies the blob at bind time (see
			// store.ts's probe note) — safe even though `bytes` here may alias a
			// reused frame buffer (onUpdatePayload's payload does; see its JSDoc).
			this.store.appendUpdate(bytes)
		} catch (err) {
			// FAIL LOUD (storage-geometry convention). This exception would
			// otherwise be SWALLOWED: persist runs synchronously inside a Loro
			// subscribeLocalUpdates callback boundary on the sending peer, and
			// loro's wasm-bindgen handleError shim eats anything thrown there —
			// the doc would stay mutated and keep relaying while the log silently
			// rotted, and every later op from the session would recover as
			// pending-forever. So: taint the actor, banner the journal, and drop
			// every transport — clients disconnect loudly, their reconnects fail
			// (connect-after-close throws on the peer, and connect() below
			// refuses while tainted). NO in-place retry: a failed WAL insert
			// means the storage layer is sick; retrying would hide it.
			this._tainted = err instanceof Error ? err : new Error(String(err))
			console.error(
				`[canvas-v2 ${this.roomId}] DURABILITY LOST — appendUpdate failed; ` +
					'tainting the actor and disconnecting all clients (no retry: the storage layer is sick). ' +
					'Clients keep their local replicas and can backfill into a healthy actor on reconnect.',
				err,
			)
			this.peer.close()
			return
		}
		if (++this.sinceCompaction >= this.compactEvery) this.compact()
	}

	connect(t: Transport): void {
		if (this._tainted) {
			throw new Error(
				`canvas-v2 room ${this.roomId} is tainted: durability lost — ${this._tainted.message}`,
			)
		}
		this.peer.connect(t)
	}

	/**
	 * Persist a fresh snapshot covering everything appended so far and prune
	 * the folded-in log rows. Note: a threshold-crossing compaction fired from
	 * persist()'s onUpdatePayload leg may snapshot imported-but-not-yet-
	 * repaired state (exportSnapshot includes imported-uncommitted data —
	 * probe-established); correct by construction, because the load path
	 * unconditionally re-runs repair()+commit() before serving.
	 */
	compact(): void {
		this.store.compact(this.peer.snapshot())
		this.sinceCompaction = 0
	}

	/**
	 * Full teardown, exception-safe. Compacts one last time — cheap, and it
	 * makes the NEXT restart's load fast (a short or empty log to replay)
	 * rather than replaying the whole session's updates. The final compaction
	 * is fallible and must NOT abort teardown: if it throws we log and move
	 * on — nothing durable is lost (the append-log the snapshot would have
	 * folded in is still intact on disk; the next load just replays it), but
	 * a skipped peer.close() would leak the peer and every transport forever
	 * (the closed-guard makes retries silent no-ops). Teardown order in the
	 * finally: (1) the persist subscription was already released up top and
	 * (2) the peer closes before the store — persist fires from peer
	 * callbacks (onUpdatePayload / subscribeLocalUpdates), so only after both
	 * is it safe to close the SQLite handle. On a TAINTED actor the compact
	 * attempt is still made: if the storage recovered it snapshots the full
	 * doc (snapshot supersedes the log — durability restored); if not, the
	 * catch logs it.
	 */
	close(): void {
		if (this.closed) return
		this.closed = true
		this.unsubPersist()
		try {
			this.compact()
		} catch (err) {
			console.error(
				`[canvas-v2 ${this.roomId}] final compaction on close failed (non-fatal: ` +
					'the append-log is intact, nothing durable is lost — the next load just replays more updates)',
				err,
			)
		} finally {
			this.peer.close()
			this.store.close()
		}
	}
}
