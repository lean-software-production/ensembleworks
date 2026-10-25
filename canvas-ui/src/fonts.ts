// The tldraw handwriting/text webfonts the canvas shape bodies name
// (tldraw_draw/_sans/_serif/_mono). Only the normal weight/style face of each
// family is declared: no canvas shape exposes bold or italic text. The font
// files themselves (SIL OFL 1.1, licences alongside them) are served by each
// host from its own static directory; `baseUrl` is that directory's URL.
//   tldraw_draw  -> Shantell Sans (Informal, Regular)
//   tldraw_sans  -> IBM Plex Sans (Medium)
//   tldraw_serif -> IBM Plex Serif (Medium)
//   tldraw_mono  -> IBM Plex Mono (Medium)
import { createElement } from 'react'

export function canvasFontFaceCss(baseUrl: string): string {
	const base = baseUrl.replace(/\/+$/, '')
	return `
@font-face {
	font-family: 'tldraw_draw';
	src: url('${base}/Shantell_Sans-Informal_Regular.woff2') format('woff2');
	font-weight: normal;
	font-style: normal;
	font-display: block;
}

@font-face {
	font-family: 'tldraw_sans';
	src: url('${base}/IBMPlexSans-Medium.woff2') format('woff2');
	font-weight: normal;
	font-style: normal;
	font-display: block;
}

@font-face {
	font-family: 'tldraw_serif';
	src: url('${base}/IBMPlexSerif-Medium.woff2') format('woff2');
	font-weight: normal;
	font-style: normal;
	font-display: block;
}

@font-face {
	font-family: 'tldraw_mono';
	src: url('${base}/IBMPlexMono-Medium.woff2') format('woff2');
	font-weight: normal;
	font-style: normal;
	font-display: block;
}
`
}

/** Renders the @font-face rules. Hosts mount it once near the canvas. */
export function CanvasFonts({ baseUrl }: { readonly baseUrl: string }) {
	return createElement('style', { 'data-canvas-fonts': '' }, canvasFontFaceCss(baseUrl))
}
