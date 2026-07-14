/**
 * The one embed-lifecycle registry shared by every canvas-v2 embed body in
 * this app (terminal/iframe/neko/screenshare/file-viewer — see ./index.ts's
 * REGISTRATION ARCHITECTURE + NEKO/FILE-VIEWER EMBED RECLASSIFICATION notes
 * for which kinds are embeds and why). Split into its own module (rather
 * than living in index.ts, which registers the shape COMPONENTS) purely to
 * avoid a import cycle: every body imports this registry to call
 * `.register()` in its own mount effect, and index.ts imports every body to
 * register its component — if the registry lived in index.ts too, that
 * would be a body importing index.ts importing that same body.
 *
 * See embedLifecycle.ts's LIFECYCLE REGISTRY block (canvas-react) for why a
 * registry (not bare props) is the mechanism, and EmbedHost.tsx's LIFECYCLE
 * WIRING header for the register-in-mount-effect pattern every body follows.
 * G3's CanvasV2App is expected to pass
 * `lifecycleFor={canvasV2EmbedLifecycles.lifecycleFor}` to its `EmbedLayer`.
 */
import { createLifecycleRegistry } from '@ensembleworks/canvas-react'

export const canvasV2EmbedLifecycles = createLifecycleRegistry()
