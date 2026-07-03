/**
 * "New terminal" toolbar button with a gateway picker (spike spec §4).
 * Plain click = default same-origin terminal; the dropdown lists remote
 * gateways from /api/gateway/list, fetched on open (no caching/polling).
 */
import { useState } from 'react'
import {
	TldrawUiButton,
	TldrawUiButtonIcon,
	TldrawUiDropdownMenuContent,
	TldrawUiDropdownMenuItem,
	TldrawUiDropdownMenuRoot,
	TldrawUiDropdownMenuTrigger,
	useEditor,
} from 'tldraw'
import { createTerminalShape } from './createTerminalShape'

interface GatewayInfo {
	gatewayId: string
	label: string
}

export function TerminalToolbarItem() {
	const editor = useEditor()
	const [gateways, setGateways] = useState<GatewayInfo[]>([])

	const refresh = () => {
		fetch('/api/gateway/list')
			.then((res) => res.json())
			.then((body: { gateways: GatewayInfo[] }) => setGateways(body.gateways))
			.catch(() => setGateways([]))
	}

	return (
		<TldrawUiDropdownMenuRoot id="terminal-gateway">
			<TldrawUiDropdownMenuTrigger>
				<TldrawUiButton type="icon" title="New terminal" onPointerDown={refresh}>
					<TldrawUiButtonIcon icon="tool-frame" />
				</TldrawUiButton>
			</TldrawUiDropdownMenuTrigger>
			<TldrawUiDropdownMenuContent side="top" align="center">
				<TldrawUiDropdownMenuItem>
					<TldrawUiButton type="menu" onClick={() => createTerminalShape(editor)}>
						This canvas (default)
					</TldrawUiButton>
				</TldrawUiDropdownMenuItem>
				{gateways.map((gw) => (
					<TldrawUiDropdownMenuItem key={gw.gatewayId}>
						<TldrawUiButton type="menu" onClick={() => createTerminalShape(editor, gw.gatewayId)}>
							{gw.label}
						</TldrawUiButton>
					</TldrawUiDropdownMenuItem>
				))}
			</TldrawUiDropdownMenuContent>
		</TldrawUiDropdownMenuRoot>
	)
}
