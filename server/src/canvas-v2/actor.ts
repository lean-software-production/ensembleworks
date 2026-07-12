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
	private sinceCompaction = 0
	private compactEvery: number
	private closed = false

	constructor(opts: ActorOpts) {
		this.store = new CanvasV2Store(opts.dir, opts.roomId)
		this.compactEvery = opts.compactEvery ?? 500

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
		// second leg is required to durably capture them.
		this.peer.doc.subscribeLocalUpdates((bytes) => this.persist(bytes))
	}

	/** The single append point both persistence hooks feed. */
	private persist(bytes: Uint8Array): void {
		// CanvasV2Store.appendUpdate copies the blob at bind time (see store.ts's
		// probe note) — safe even though `bytes` here may alias a reused frame
		// buffer (onUpdatePayload's payload does; see its JSDoc).
		this.store.appendUpdate(bytes)
		if (++this.sinceCompaction >= this.compactEvery) this.compact()
	}

	connect(t: Transport): void {
		this.peer.connect(t)
	}

	/** Persist a fresh snapshot covering everything appended so far and prune the folded-in log rows. */
	compact(): void {
		this.store.compact(this.peer.snapshot())
		this.sinceCompaction = 0
	}

	/**
	 * Close the underlying peer (real close semantics per Unit 4: idempotent,
	 * detaches subscriptions, closes every connected transport; connect() after
	 * close throws). Also compacts one last time — cheap (this actor already
	 * holds the doc and the store open) and it makes the NEXT restart's load
	 * fast (a short or empty log to replay) rather than replaying the whole
	 * session's updates. Exercises nothing risky: compact() is just an
	 * INSERT-then-DELETE the store already does routinely.
	 */
	close(): void {
		if (this.closed) return
		this.closed = true
		this.compact()
		this.peer.close()
	}
}
