/**
 * Discord bindings admin dialog (client milestone B3). Opened as a tldraw
 * dialog via the plugin bar item (see plugin.tsx). v1 admin surface: lists the
 * current room's bindings, lets you delete one, and add a new one. Structured
 * like terminal/openNewTerminal.tsx's dialog (TLUiDialogProps + tldraw dialog
 * chrome) so it looks native.
 */
import { useEffect, useState } from 'react'
import {
	TldrawUiButton,
	TldrawUiDialogBody,
	TldrawUiDialogCloseButton,
	TldrawUiDialogHeader,
	TldrawUiDialogTitle,
	type TLUiDialogProps,
} from 'tldraw'
import { getRoomId } from '../identity'
import {
	createBinding,
	deleteBinding,
	listBindings,
	type DiscordBinding,
} from './api'

const inputStyle: React.CSSProperties = {
	padding: '4px 6px',
	border: '1px solid var(--tl-color-muted-1)',
	borderRadius: 4,
	background: 'var(--tl-color-panel)',
	color: 'var(--tl-color-text)',
	font: 'inherit',
}

const labelStyle: React.CSSProperties = {
	display: 'flex',
	flexDirection: 'column',
	gap: 2,
	fontSize: 12,
}

export function BindingsPanel({ onClose }: TLUiDialogProps) {
	const room = getRoomId()
	const [bindings, setBindings] = useState<DiscordBinding[]>([])
	const [error, setError] = useState<string | null>(null)

	const [channelId, setChannelId] = useState('')
	const [guildId, setGuildId] = useState('')
	const [direction, setDirection] = useState<'in' | 'out'>('in')
	const [handler, setHandler] = useState('frame-sticky')
	const [frameId, setFrameId] = useState('')

	const refetch = () => {
		listBindings(room)
			.then((list) => {
				setBindings(list)
				setError(null)
			})
			.catch((err) => setError(String(err?.message ?? err)))
	}

	// room is stable per mount; load the list once when the dialog opens.
	useEffect(() => {
		refetch()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	const onDelete = (id: string) => {
		deleteBinding(id)
			.then(() => refetch())
			.catch((err) => setError(String(err?.message ?? err)))
	}

	const onAdd = (e: React.FormEvent) => {
		e.preventDefault()
		const params: Record<string, unknown> = frameId.trim() ? { frameId: frameId.trim() } : {}
		createBinding({
			room,
			guildId,
			channelId,
			direction,
			route: { handler, params },
		})
			.then(() => {
				refetch()
				setChannelId('')
				setGuildId('')
				setFrameId('')
			})
			.catch((err) => setError(String(err?.message ?? err)))
	}

	return (
		<>
			<TldrawUiDialogHeader>
				<TldrawUiDialogTitle>Discord bindings</TldrawUiDialogTitle>
				<TldrawUiDialogCloseButton />
			</TldrawUiDialogHeader>
			<TldrawUiDialogBody style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 320 }}>
				{error && (
					<div style={{ color: 'var(--tl-color-warning)', fontSize: 12 }}>{error}</div>
				)}

				<div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
					{bindings.length === 0 && (
						<div style={{ fontSize: 12, opacity: 0.7 }}>No bindings for this room yet.</div>
					)}
					{bindings.map((b) => (
						<div
							key={b.id}
							style={{
								display: 'flex',
								alignItems: 'center',
								gap: 8,
								fontSize: 12,
								padding: '2px 0',
							}}
						>
							<span style={{ flex: 1 }}>
								<strong>{b.channelId}</strong> · {b.direction} · {b.route.handler}
							</span>
							<TldrawUiButton type="danger" onClick={() => onDelete(b.id)}>
								delete
							</TldrawUiButton>
						</div>
					))}
				</div>

				<form onSubmit={onAdd} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
					<label style={labelStyle}>
						channel id
						<input
							style={inputStyle}
							value={channelId}
							onChange={(e) => setChannelId(e.currentTarget.value)}
							required
						/>
					</label>
					<label style={labelStyle}>
						guild id
						<input
							style={inputStyle}
							value={guildId}
							onChange={(e) => setGuildId(e.currentTarget.value)}
							required
						/>
					</label>
					<label style={labelStyle}>
						direction
						<select
							style={inputStyle}
							value={direction}
							onChange={(e) => setDirection(e.currentTarget.value as 'in' | 'out')}
						>
							<option value="in">in</option>
							<option value="out">out</option>
						</select>
					</label>
					<label style={labelStyle}>
						handler
						<input
							style={inputStyle}
							value={handler}
							onChange={(e) => setHandler(e.currentTarget.value)}
							required
						/>
					</label>
					<label style={labelStyle}>
						frame id (optional)
						<input
							style={inputStyle}
							value={frameId}
							onChange={(e) => setFrameId(e.currentTarget.value)}
						/>
					</label>
					<div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
						<TldrawUiButton type="normal" onClick={() => onClose()}>
							close
						</TldrawUiButton>
						<TldrawUiButton type="primary" onClick={onAdd}>
							add binding
						</TldrawUiButton>
					</div>
				</form>
			</TldrawUiDialogBody>
		</>
	)
}
