/**
 * A/V plugin: the session panel (roster, faces rail, spatial audio,
 * transcript, VM strip) claims tldraw's SharePanel slot.
 */
import type { ClientPlugin } from '../kernel/plugin'
import { AvOverlay } from './AvOverlay'

export const avPlugin: ClientPlugin = {
	id: 'av',
	uiSlots: { SharePanel: AvOverlay },
}
