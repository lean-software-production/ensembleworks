/**
 * Presenting state (canvas-controls spec §5 "Present"): who — if anyone — is
 * currently presenting, derived from the sync presence channel rather than a
 * dedicated server message.
 *
 * Why presence meta: App.tsx's `getUserPresence` already publishes a custom
 * `meta` blob on every presence update (the spatial stamp) — this rides that
 * SAME channel, so starting/stopping Present needs NO server changes. Every
 * client (including late joiners, who receive the current presence snapshot
 * on connect) derives "who is presenting" by scanning collaborator presence
 * for `meta.presenting === true`; if the presenter disconnects, presence
 * expiry removes their record and every viewer self-heals with no explicit
 * "stop presenting" message required. Because it's broadcast on every
 * presence update, the meta payload MUST stay JSON-serializable and tiny —
 * the presenting boolean here, plus the raise-hand queue's two small fields
 * (handRaised, handoff — see the queue section below), alongside the stamp.
 */
import { useEffect, useRef } from 'react'
import { atom, useValue, type Editor } from 'tldraw'
import {
	handQueue as deriveHandQueue,
	handPosition,
	incomingHandoffTs,
	type HandRaiser,
} from './handQueue'

// tldraw's TLInstancePresence type isn't re-exported from the 'tldraw'
// package root (only reachable via @tldraw/tlschema, not a direct
// dependency here) — derive it from Editor.getCollaborators()'s own return
// type instead of importing across that boundary.
type Collaborator = ReturnType<Editor['getCollaborators']>[number]

/** Local atom: is *this* client presenting? Read by App.tsx's getUserPresence
 * so flipping it republishes our presence meta (see App.tsx's comment). */
export const presentingAtom = atom('ew presenting', false)

/** Reactive read of whether this client is currently presenting. */
export function useIsPresenting(): boolean {
	return useValue(presentingAtom)
}

export interface Presenter {
	userId: string
	userName: string
}

/**
 * Shared predicate: does this collaborator's presence meta say they're
 * presenting? Both `usePresenter` (scanning for who) and `tryStartPresenting`
 * (checking whether anyone already is) need exactly this check — kept in one
 * place so the `meta.presenting === true` shape is only asserted once.
 */
function isPresentingCollaborator(c: Collaborator): boolean {
	const meta = c.meta as { presenting?: unknown } | undefined
	return meta?.presenting === true
}

/**
 * The current presenter among collaborators (never self — this only scans
 * peer presence), or null if nobody else is presenting. Reactive: recomputes
 * whenever any collaborator's presence changes.
 */
export function usePresenter(editor: Editor): Presenter | null {
	return useValue(
		'ew presenter',
		() => {
			const presenter = editor.getCollaborators().find(isPresentingCollaborator)
			if (!presenter) return null
			return { userId: presenter.userId, userName: presenter.userName?.trim() || 'Anonymous' }
		},
		[editor],
	)
}

/**
 * Start presenting UNLESS someone else already is. This is the imperative
 * guard for the Present button/accelerator: render-derived state (the hidden
 * button, the keydown closure's `presenter`) lags presence updates, so two
 * people pressing P inside that window would BOTH flip their atoms and never
 * learn about each other. Scanning collaborators at click-time closes the
 * render-lag half of that race; the residual network-propagation race (both
 * presses land before either presence update arrives) can't be closed
 * client-side and is surfaced instead — PresenterStrip shows "⟨name⟩ is also
 * presenting" whenever a second presenter's meta appears.
 *
 * Returns whether presenting actually started.
 */
export function tryStartPresenting(editor: Editor): boolean {
	const someoneElse = editor.getCollaborators().some(isPresentingCollaborator)
	if (someoneElse) return false
	enterPresenting()
	return true
}

// --- Raise-hand / request-to-present queue (Present mode) ---
//
// A viewer (or anyone, even when nobody presents) raises a hand to request the
// room; the presenter sees the queue in raise order and hands off to the next
// person. Like `presenting`, this rides App.tsx's presence `meta` — two tiny
// fields a client owns via the atoms below, read inside getUserPresence so
// flipping them republishes presence. Ordering/handoff logic is the pure,
// unit-tested code in ./handQueue; this layer is just the local atoms, the
// reactive hooks over getCollaborators(), and the imperative verbs the bar
// calls. No server message is involved.

/** A promotion this (presenting) client is handing to a specific peer. A `type`
 * (not interface) so it satisfies presence meta's JsonObject index signature —
 * same reason presentStore's Presenting is a type. */
export type Handoff = { to: string; at: number }

/** Local atom: Date.now() when THIS client raised its hand, or null when down.
 * Read by App.tsx's getUserPresence. The timestamp both marks us as queued and
 * fixes our place in line (earliest first). */
export const handRaisedAtom = atom<number | null>('ew handRaised', null)

/** Local atom: a pending handoff we (as presenter) stamped to promote a peer.
 * Rides our presence meta until the addressed client consumes it; cleared
 * whenever we (re)start presenting, and self-clears via a short TTL. */
export const handoffAtom = atom<Handoff | null>('ew handoff', null)

/** Reactive: is this client's hand up? */
export function useHandRaised(): boolean {
	return useValue('ew hand raised', () => handRaisedAtom.get() !== null, [])
}

/** Reactive: this client's 1-based place in line, or null when the hand is down. */
export function useHandPosition(editor: Editor): number | null {
	return useValue(
		'ew hand position',
		() => handPosition(editor.getCollaborators(), handRaisedAtom.get()),
		[editor]
	)
}

/** Reactive: the ordered raise-hand queue among peers (never self —
 * getCollaborators excludes us), first-raised first. */
export function useHandQueue(editor: Editor): HandRaiser[] {
	return useValue('ew hand queue', () => deriveHandQueue(editor.getCollaborators()), [editor])
}

/** Raise our hand if it isn't already up. Idempotent: an already-raised hand
 * KEEPS its original timestamp, so re-raising can't shuffle us to the back of
 * the line (mirrors presentStore's preserve-ts rule). */
export function raiseHand() {
	if (handRaisedAtom.get() === null) handRaisedAtom.set(Date.now())
}

/** Lower our hand — leaves the queue (spec: lowering removes you). */
export function lowerHand() {
	handRaisedAtom.set(null)
}

/** Toggle for the raise-hand button / accelerator. */
export function toggleHand() {
	handRaisedAtom.set(handRaisedAtom.get() === null ? Date.now() : null)
}

/**
 * Enter presenting: clear any stale handoff we carry and drop out of the queue
 * (becoming the presenter removes you), then flip the presenting flag. Shared
 * by tryStartPresenting and the handoff consumer so both entry paths satisfy
 * the same invariants.
 */
function enterPresenting() {
	handoffAtom.set(null)
	handRaisedAtom.set(null)
	presentingAtom.set(true)
}

/**
 * Presenter action: hand the room to `userId`. We stamp a handoff token in our
 * meta and stop presenting; the addressed client sees the token over presence
 * and takes over (useConsumeHandoff). The token then self-clears after a beat —
 * long enough to propagate, short enough that a lingering token can't
 * re-promote the same person on a much later refresh. (enterPresenting also
 * clears it if we start presenting again first; the guard keeps this timeout
 * from clobbering a newer token.)
 */
export function promoteTo(userId: string) {
	const at = Date.now()
	handoffAtom.set({ to: userId, at })
	presentingAtom.set(false)
	setTimeout(() => {
		const h = handoffAtom.get()
		if (h && h.to === userId && h.at === at) handoffAtom.set(null)
	}, 5000)
}

/**
 * Consume a promotion addressed to us. The presenter promotes by stamping a
 * handoff token ({ to: us, at }) into ITS presence; we watch peer meta for the
 * newest such token and — edge-triggered on a rising `at`, so we react exactly
 * once even though the token lingers briefly — take over the room. No server
 * round-trip: the token rides presence like everything else in Present mode.
 */
export function useConsumeHandoff(editor: Editor) {
	// Last handoff timestamp we've already acted on. Starts at -1 so a token
	// already present at mount (e.g. we were promoted, then refreshed) is
	// honoured once; a rising `at` fires again for a genuine re-promotion.
	const consumedRef = useRef(-1)
	const myId = useValue('ew self id', () => editor.user.getId(), [editor])
	const pendingTs = useValue(
		'ew incoming handoff',
		() => incomingHandoffTs(editor.getCollaborators(), myId),
		[editor, myId]
	)
	useEffect(() => {
		if (pendingTs !== null && pendingTs > consumedRef.current) {
			consumedRef.current = pendingTs
			enterPresenting()
		}
	}, [pendingTs])
}
