/**
 * Per-machine opt-out for the terminal's WebGL renderer.
 *
 * On at least one Linux/Wayland + Mesa machine the WebGL glyph atlas corrupts
 * silently mid-session (characters render as boxes) WITHOUT a context-loss
 * event, so the addon's own fallback never fires. Machines that exhibit this
 * set localStorage['ensembleworks:webgl'] = 'off' to skip the addon entirely
 * and stay on the DOM renderer. Anything else — unset, other values, or a
 * storage that throws (privacy mode) — leaves WebGL on: it is the default
 * experience, and the flag is a targeted escape hatch, not a setting.
 */

export const WEBGL_PREF_KEY = 'ensembleworks:webgl'

export function webglEnabled(store: Pick<Storage, 'getItem'>): boolean {
	try {
		return store.getItem(WEBGL_PREF_KEY) !== 'off'
	} catch {
		return true
	}
}
