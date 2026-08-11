/**
 * The "new codespace" flow (openNewTerminal.tsx pattern — a tldraw *dialog*,
 * not a nested dropdown; nested Radix dropdowns silently fail inside tldraw's
 * toolbar). A codespace gateway is a list entry carrying repo metadata; plain
 * gateways stay in the terminal picker. Lifecycle is CLI-side for v1, so an
 * empty list points at `ew codespace up`.
 */
import {
	TldrawUiButton,
	TldrawUiDialogBody,
	TldrawUiDialogCloseButton,
	TldrawUiDialogHeader,
	TldrawUiDialogTitle,
	type Editor,
	type TLUiDialogProps,
} from 'tldraw'
import type { BarItemHelpers } from '../kernel/plugin'
import { createCodespaceShape } from './createCodespaceShape'
import type { GatewayListEntry } from './gatewayView'

async function fetchCodespaceGateways(): Promise<GatewayListEntry[]> {
	try {
		const res = await fetch('/api/terminal/list')
		if (!res.ok) return []
		const body = (await res.json()) as { gateways?: GatewayListEntry[] }
		return (body.gateways ?? []).filter((g) => g.repo)
	} catch {
		return []
	}
}

function CodespacePickerDialog({
	onClose,
	editor,
	gateways,
}: TLUiDialogProps & { editor: Editor; gateways: GatewayListEntry[] }) {
	const pick = (gw: GatewayListEntry) => {
		createCodespaceShape(editor, gw)
		onClose()
	}
	return (
		<>
			<TldrawUiDialogHeader>
				<TldrawUiDialogTitle>New codespace</TldrawUiDialogTitle>
				<TldrawUiDialogCloseButton />
			</TldrawUiDialogHeader>
			<TldrawUiDialogBody style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
				{gateways.length === 0 ? (
					<div style={{ maxWidth: 320 }}>
						No codespace gateways are connected. Start one from a checkout with{' '}
						<code>ew codespace up</code> (or <code>ew terminal connect --repo …</code>), then
						reopen this dialog.
					</div>
				) : (
					gateways.map((gw) => (
						<TldrawUiButton key={gw.gatewayId} type="normal" onClick={() => pick(gw)}>
							{gw.repo}
							{gw.branch ? `@${gw.branch}` : ''} ({gw.label})
						</TldrawUiButton>
					))
				)}
			</TldrawUiDialogBody>
		</>
	)
}

export function openNewCodespace(editor: Editor, helpers: BarItemHelpers): void {
	void fetchCodespaceGateways().then((gateways) => {
		helpers.addDialog({
			id: 'codespace-gateway-picker', // dedupe: double-activation reuses the one dialog
			component: (props: TLUiDialogProps) => (
				<CodespacePickerDialog {...props} editor={editor} gateways={gateways} />
			),
		})
	})
}
