export function sanitizeId(id: string): string | null {
	return /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : null
}

// Uploaded asset ids may carry a file extension — the client assetStore keeps
// dots from the original filename ("<uniqueId>-photo.png") — but must remain
// one safe path segment: no leading dot (blocks ".", ".." and dotfiles), no
// separators. Room ids keep the stricter sanitizeId above.
export function sanitizeAssetId(id: string): string | null {
	return /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,63}$/.test(id) ? id : null
}
