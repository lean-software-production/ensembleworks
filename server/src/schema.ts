/**
 * The store schema shared by every room. Shape prop validators live in
 * @ensembleworks/contracts — the same objects each client ShapeUtil uses.
 */
import { createTLSchema, defaultBindingSchemas, defaultShapeSchemas } from '@tldraw/tlschema'
import {
	fileViewerShapeProps,
	iframeShapeProps,
	nekoShapeProps,
	roadmapShapeProps,
	screenshareShapeProps,
	terminalShapeProps,
} from '@ensembleworks/contracts'

export const schema = createTLSchema({
	shapes: {
		...defaultShapeSchemas,
		terminal: { props: terminalShapeProps },
		iframe: { props: iframeShapeProps },
		neko: { props: nekoShapeProps },
		roadmap: { props: roadmapShapeProps },
		screenshare: { props: screenshareShapeProps },
		'file-viewer': { props: fileViewerShapeProps },
	},
	bindings: defaultBindingSchemas,
})
