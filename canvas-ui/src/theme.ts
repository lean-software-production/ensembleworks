// The only styling vocabulary canvas-ui chrome reads. Each host maps its own
// theme onto these custom properties; the fallbacks are the web app's current
// look, so a host that maps nothing renders exactly as before. Document
// content colours (shape colours, colour swatch fills) are never themed here.
export const UI_VARS = {
	panelBg: 'var(--canvas-ui-panel-bg, #fafaf7)',
	panelFg: 'var(--canvas-ui-panel-fg, #0f172a)',
	panelMuted: 'var(--canvas-ui-panel-muted, #475569)',
	panelBorder: 'var(--canvas-ui-panel-border, rgba(15,23,42,0.14))',
	controlBorder: 'var(--canvas-ui-control-border, rgba(15,23,42,0.22))',
	accent: 'var(--canvas-ui-accent, #004990)',
	accentFg: 'var(--canvas-ui-accent-fg, #fafaf7)',
	accentSoft: 'var(--canvas-ui-accent-soft, #dbe6fb)',
	// Panel drop shadow (StylePanel's PANEL_STYLE.boxShadow).
	shadow: 'var(--canvas-ui-shadow, 0 2px 10px rgba(15,23,42,0.18))',
	// Swatch/segmented-button inactive border (StylePanel's swatchButtonStyle).
	swatchBorder: 'var(--canvas-ui-swatch-border, rgba(15,23,42,0.25))',
	// Opacity slider inactive stop dot (StylePanel's opacityStopStyle).
	trackLine: 'var(--canvas-ui-track-line, rgba(15,23,42,0.4))',
} as const

export type UiVar = keyof typeof UI_VARS
