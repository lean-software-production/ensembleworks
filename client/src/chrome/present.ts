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
 * a single boolean here, alongside the existing stamp.
 */
import { atom, useValue, type Editor } from 'tldraw'

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
	presentingAtom.set(true)
	return true
}
