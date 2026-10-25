/**
 * Context-menu desync workaround (tldraw 5.1.0).
 *
 * THE BUG: after the context menu was dismissed by clicking away, right-click
 * never opened it again for the rest of the session. Only a page refresh
 * brought it back. Dismissing with Escape left it working, which is what makes
 * the shape of the bug visible.
 *
 * WHY: tldraw's context menu is a Radix `ContextMenu.Root` whose content is
 * gated on tldraw's OWN registry — `{isOpen && <Portal>…}` in
 * DefaultContextMenu.tsx, where `isOpen` comes from the `tlmenus` atom. Two
 * sources of truth for one menu. `MenuClickCapture` — the invisible overlay
 * mounted while a menu is open — calls `editor.menus.clearOpenMenus()` directly
 * on a left-click (MenuClickCapture.tsx:102). That empties tldraw's registry, so
 * the content unmounts, but Radix is never told: its Root stays `open`, and its
 * trigger keeps `data-state="open"` forever. Every later right-click then calls
 * Radix's `setOpen(true)`, which is a no-op because Radix already believes it is
 * open, so `onOpenChange` never fires, tldraw's registry is never repopulated,
 * and no menu renders. A permanent deadlock.
 *
 * Escape escapes it because that path goes through Radix's own DismissableLayer,
 * which closes Radix and tldraw together, leaving both sides agreeing.
 *
 * tldraw knows about this hazard — the right-click branch of that same function
 * deliberately does NOT clear the registry, and says why:
 * "We don't clearOpenMenus() — Radix's DismissableLayer closes the menu via
 * outside-click detection, keeping its internal state in sync"
 * (MenuClickCapture.tsx:93). The left-click branch below it does exactly what
 * that comment warns against.
 *
 * THE FIX: remount `DefaultContextMenu` whenever the menu goes from open to
 * closed. A fresh Radix Root starts closed, so the two sides can never drift
 * apart for more than one close. Remounting a closed menu costs nothing — there
 * is no open UI to disturb, and the next right-click builds it fresh.
 *
 * This is a workaround for an upstream bug, not a design. If a later tldraw
 * fixes the desync (make MenuClickCapture close via Radix, or drop the second
 * source of truth), delete this file and put `ContextMenu` back to the default.
 * `e2e/tests/context-menu.spec.ts` covers the behaviour either way.
 */
import { useEffect, useRef, useState } from 'react'
import { DefaultContextMenu, useEditor, useValue } from 'tldraw'

export function ResilientContextMenu() {
	const editor = useEditor()
	const isOpen = useValue('any menu open', () => editor.menus.hasAnyOpenMenus(), [editor])
	const [generation, setGeneration] = useState(0)
	const wasOpen = useRef(false)

	useEffect(() => {
		// Only the open → closed edge remounts. Bumping on every change would
		// tear down the menu mid-open, the moment it appeared.
		if (wasOpen.current && !isOpen) setGeneration((n) => n + 1)
		wasOpen.current = isOpen
	}, [isOpen])

	return <DefaultContextMenu key={generation} />
}
