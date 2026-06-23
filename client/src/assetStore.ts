import { TLAssetStore, uniqueId } from 'tldraw'

/**
 * Stores canvas assets (dropped images, videos) on the sync server rather
 * than inline as base64 in the document.
 */
export const assetStore: TLAssetStore = {
	async upload(_asset, file) {
		const id = `${uniqueId()}-${file.name.replace(/[^a-zA-Z0-9_.-]/g, '_')}`.slice(0, 64)
		const res = await fetch(`/uploads/${id}`, { method: 'PUT', body: file })
		if (!res.ok) throw new Error(`asset upload failed: ${res.status}`)
		return { src: `/uploads/${id}` }
	},
	resolve(asset) {
		return asset.props.src
	},
}
