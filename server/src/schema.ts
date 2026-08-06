/**
 * The store schema shared by every room. Shape prop validators live in
 * @ensembleworks/contracts — the same objects each client ShapeUtil uses.
 */
import { createTLSchema, defaultBindingSchemas, defaultShapeSchemas } from '@tldraw/tlschema'
import {
	nekoShapeProps,
	roadmapShapeProps,
	screenshareShapeProps,
	terminalShapeProps,
	webViewerMigrations,
	webViewerShapeProps,
} from '@ensembleworks/contracts'

export const schema = createTLSchema({
	shapes: {
		...defaultShapeSchemas,
		terminal: { props: terminalShapeProps },
		neko: { props: nekoShapeProps },
		roadmap: { props: roadmapShapeProps },
		screenshare: { props: screenshareShapeProps },
		'web-viewer': { props: webViewerShapeProps },
	},
	bindings: defaultBindingSchemas,
	migrations: [webViewerMigrations],
})
