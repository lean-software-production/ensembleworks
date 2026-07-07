/**
 * The "new terminal" flow, decoupled from any toolbar component so both the
 * command bar (barItems) and keyboard accelerator can call it. Fast path: no
 * remote gateways registered → create a local terminal immediately;
 * otherwise open the gateway-picker dialog.
 *
 * The picker is a tldraw *dialog*, not a nested dropdown, by design: a nested
 * Radix dropdown trigger inside tldraw's toolbar "More" popover silently
 * closes the popover instead of opening (found via headless probe).
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
import { createTerminalShape } from './createTerminalShape'

interface GatewayInfo {
	gatewayId: string
	label: string
}

async function fetchGateways(): Promise<GatewayInfo[]> {
	try {
		const res = await fetch('/api/terminal/list')
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

export function openNewTerminal(editor: Editor, helpers: BarItemHelpers): void {
	void fetchGateways().then((gateways) => {
		if (gateways.length === 0) {
			createTerminalShape(editor)
			return
		}
		helpers.addDialog({
			id: 'terminal-gateway-picker', // dedupe: double-activation reuses the one dialog
			component: (props: TLUiDialogProps) => (
				<GatewayPickerDialog {...props} editor={editor} gateways={gateways} />
			),
		})
	})
}
