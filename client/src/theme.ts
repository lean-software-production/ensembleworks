/**
 * Wellmaintained brand tokens for the canvas chrome.
 *
 * Colors and type lifted from the Wellmaintained design system
 * (colors_and_type.css): paper surfaces, charcoal ink, seal-blue as the
 * single brand accent, kraft browns used sparingly, four semantic colors.
 * Keep in sync with the CSS custom properties in theme.css.
 */

export const wm = {
	// Surfaces (off-white family)
	bg: '#fafaf7',
	bgWarm: '#f6f3ec',
	panel: '#f2f0ea',
	panelWarm: '#ece7da',

	// Foreground (charcoal ink)
	ink: '#0f172a',
	inkMuted: 'rgba(15,23,42,0.58)',
	inkSubtle: 'rgba(15,23,42,0.40)',

	// Rules / borders
	rule: 'rgba(15,23,42,0.10)',
	ruleStrong: 'rgba(15,23,42,0.22)',

	// Accents
	sealBlue: '#004990',
	cream: '#f6efe2',
	accentSoft: '#f4e4cc',
	kraft: '#a47246',
	kraftDeep: '#6b4423',

	// Semantic
	ok: '#15a386',
	warn: '#ea8a1a',
	crit: '#e0322a',
	info: '#1d76d6',

	// Type
	// Keep in sync with --wm-mono in theme.css. Symbols Nerd Font Mono is the
	// self-hosted symbols-only fallback (PUA glyphs); JetBrains Mono stays
	// primary so the terminal's measured cell is unchanged.
	mono: '"JetBrains Mono", "Symbols Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
	sans: '"PT Sans", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',

	// Elevation — flat, paper-like
	shadowPaper: '0 4px 24px rgba(0,0,0,0.08)',
} as const

/**
 * xterm.js theme: terminal as a typewritten document on paper.
 *
 * The brand's semantic colors are tuned for chips, not 13px text on an
 * off-white ground, so the normal ANSI slots carry darkened derivatives of
 * the same hues (legible for ls/git/vim output) while the brights keep the
 * original chip values. tmux's omarchy-derived chrome only uses named ANSI
 * colors, so it inherits this palette wholesale.
 */
export const paperTerminalTheme = {
	// Pure white so terminals match the other frames (iframe/web views),
	// reading as fresh sheets laid over the room's warmer paper.
	background: '#fff',
	foreground: wm.ink,
	cursor: wm.sealBlue,
	cursorAccent: wm.cream,
	selectionBackground: wm.accentSoft,

	black: '#0f172a',
	red: '#c22720',
	green: '#0e7a64',
	yellow: '#9a6200',
	blue: '#004990',
	magenta: '#6b4423', // kraft stands in for magenta — the brand has no purple
	cyan: '#0e6e8a',
	white: '#ece7da',

	brightBlack: '#5e6677',
	brightRed: '#e0322a',
	brightGreen: '#15a386',
	brightYellow: '#ea8a1a',
	brightBlue: '#1d76d6',
	brightMagenta: '#a47246',
	brightCyan: '#2596be',
	brightWhite: '#fafaf7',
} as const
