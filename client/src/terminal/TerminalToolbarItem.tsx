/**
 * "New terminal" toolbar item with a gateway picker (spike spec §4).
 *
 * Rendered as a plain TldrawUiMenuItem so tldraw's toolbar overflow can
 * manage it — at common widths the custom tools live in the "More" popover,
 * where a nested Radix dropdown trigger silently closes the popover instead
 * of opening (found via headless probe). onSelect therefore opens a tldraw
 * *dialog* to pick the gateway, which works from both toolbar contexts.
 * Fast path: no remote gateways registered → create a local terminal
 * immediately, exactly like the pre-spike button.
 */
import {
	TldrawUiButton,
	TldrawUiDialogBody,
	TldrawUiDialogCloseButton,
	TldrawUiDialogHeader,
	TldrawUiDialogTitle,
	TldrawUiMenuItem,
	useDialogs,
	useEditor,
	type Editor,
	type TLUiDialogProps,
} from 'tldraw'
import { createTerminalShape } from './createTerminalShape'

interface GatewayInfo {
	gatewayId: string
	label: string
}

async function fetchGateways(): Promise<GatewayInfo[]> {
	try {
		const res = await fetch('/api/gateway/list')
		if (!res.ok) return []
		const body = (await res.json()) as { gateways: GatewayInfo[] }
		return body.gateways ?? []
	} catch {
		return []
	}
}

function GatewayPickerDialog({
	onClose,
	editor,
	gateways,
}: TLUiDialogProps & { editor: Editor; gateways: GatewayInfo[] }) {
	const pick = (gateway?: string) => {
		createTerminalShape(editor, gateway)
		onClose()
	}
	return (
		<>
			<TldrawUiDialogHeader>
				<TldrawUiDialogTitle>New terminal</TldrawUiDialogTitle>
				<TldrawUiDialogCloseButton />
			</TldrawUiDialogHeader>
			<TldrawUiDialogBody style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
				<TldrawUiButton type="normal" onClick={() => pick()}>
					This canvas (default)
				</TldrawUiButton>
				{gateways.map((gw) => (
					<TldrawUiButton key={gw.gatewayId} type="normal" onClick={() => pick(gw.gatewayId)}>
						{gw.label}
					</TldrawUiButton>
				))}
			</TldrawUiDialogBody>
		</>
	)
}

export function TerminalToolbarItem() {
	const editor = useEditor()
	const { addDialog } = useDialogs()

	return (
		<TldrawUiMenuItem
			id="terminal"
			icon="tool-frame"
			label="New terminal"
			readonlyOk={false}
			onSelect={() => {
				void fetchGateways().then((gateways) => {
					if (gateways.length === 0) {
						createTerminalShape(editor)
						return
					}
					addDialog({
						id: 'terminal-gateway-picker', // dedupe: double-activation reuses the one dialog
						component: (props) => (
							<GatewayPickerDialog {...props} editor={editor} gateways={gateways} />
						),
					})
				})
			}}
		/>
	)
}
