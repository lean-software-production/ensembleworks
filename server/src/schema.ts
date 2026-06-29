/**
 * The store schema shared by every room. Custom shapes must be registered
 * here as well as on the client, so the sync server can validate and migrate
 * their records.
 */
import { createTLSchema, defaultBindingSchemas, defaultShapeSchemas } from '@tldraw/tlschema'
import { T } from '@tldraw/validate'

// Keep in sync with client/src/terminal/TerminalShapeUtil.tsx
const terminalShapeProps = {
	w: T.number,
	h: T.number,
	sessionId: T.string,
	title: T.string,
	// Optional status light set via POST /api/terminal-status; optional so
	// existing rooms need no migration.
	status: T.string.optional(),
}

// Keep in sync with client/src/iframe/IframeShapeUtil.tsx
const iframeShapeProps = {
	w: T.number,
	h: T.number,
	url: T.string,
	title: T.string,
}

// Keep in sync with client/src/neko/NekoShapeUtil.tsx
const nekoShapeProps = {
	w: T.number,
	h: T.number,
	base: T.string,
	title: T.string,
}

export const schema = createTLSchema({
	shapes: {
		...defaultShapeSchemas,
		terminal: { props: terminalShapeProps },
		iframe: { props: iframeShapeProps },
		neko: { props: nekoShapeProps },
	},
	bindings: defaultBindingSchemas,
})
