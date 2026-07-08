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
 * The current presenter among collaborators (never self — this only scans
 * peer presence), or null if nobody else is presenting. Reactive: recomputes
 * whenever any collaborator's presence changes.
 */
export function usePresenter(editor: Editor): Presenter | null {
	return useValue(
		'ew presenter',
		() => {
			const presenter = editor.getCollaborators().find((c) => {
				const meta = c.meta as { presenting?: unknown } | undefined
				return meta?.presenting === true
			})
			if (!presenter) return null
			return { userId: presenter.userId, userName: presenter.userName?.trim() || 'Anonymous' }
		},
		[editor],
	)
}
