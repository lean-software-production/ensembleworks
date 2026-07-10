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

/**
 * True unless this machine opted out. Takes the storage lazily (a function)
 * because accessing window.localStorage ITSELF throws in browsers with
 * storage fully blocked — the whole read path must sit inside the try.
 * The flag is read once per terminal mount, so changes take effect on reload.
 */
export function webglEnabled(getStore: () => Pick<Storage, 'getItem'>): boolean {
	try {
		return getStore().getItem(WEBGL_PREF_KEY) !== 'off'
	} catch {
		return true
	}
}
