/**
 * The client plugin registry: the one ordered list of features composed into
 * the editor. Order is meaningful — it fixes shape-util registration order,
 * command-bar order (spec §8: priority items, then overflow items) and menu
 * order, and reproduces the pre-registry hard-coded ordering exactly:
 *   shape utils  terminal, iframe, neko, roadmap, screenshare
 *   bar items    priority items (terminal, cast) render in the bar; overflow
 *                items (dev-server, neko/browser, roadmap) render in the ⋯
 *                menu — each group in registry order
 *   menu         seed-demo, seed-session
 */
import { avPlugin } from './av/plugin'
import { demoPlugin } from './demo/plugin'
import { fileViewerPlugin } from './file-viewer/plugin'
import { iframePlugin } from './iframe/plugin'
import type { ClientPlugin } from './kernel/plugin'
import { nekoPlugin } from './neko/plugin'
import { roadmapPlugin } from './roadmap/plugin'
import { screensharePlugin } from './screenshare/plugin'
import { sessionPlugin } from './session/plugin'
import { terminalPlugin } from './terminal/plugin'

export const plugins: readonly ClientPlugin[] = [
	terminalPlugin,
	iframePlugin,
	nekoPlugin,
	roadmapPlugin,
	fileViewerPlugin,
	screensharePlugin,
	avPlugin,
	demoPlugin,
	sessionPlugin,
]
