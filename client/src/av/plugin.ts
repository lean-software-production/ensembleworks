/**
 * A/V plugin: AvOverlay claims tldraw's SharePanel slot to stay mounted
 * inside tldraw context (LiveKit connection, spatial-audio loop, leash
 * overlay) — it renders no panel UI itself since the Task 5 cutover; the
 * side panel (chrome/SidePanel.tsx, an App-level flex sibling) owns the
 * roster, tiles, recording row and transcript modal.
 */
import type { ClientPlugin } from '../kernel/plugin'
import { AvOverlay } from './AvOverlay'

export const avPlugin: ClientPlugin = {
	id: 'av',
	uiSlots: { SharePanel: AvOverlay },
}
