// Captures/loads tldraw's interaction "feel" constants — the numbers the
// future canvas engine must reproduce (drag threshold, nudge amounts, wheel
// zoom ratio). See tests/feel.spec.ts for the capture procedure.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

export interface FeelNumbers {
	dragThresholdPx: number // min pointer travel before a shape actually moves
	nudgePx: number // ArrowRight on a selected shape
	shiftNudgePx: number // Shift+ArrowRight
	wheelZoomRatio: number // zoom multiplier for one ctrl+wheel tick (deltaY -100)
}

const FILE = path.join(import.meta.dirname, '../goldens/feel.json')
export const capturing = process.env.EW_CAPTURE === '1'
export const saveFeel = (f: FeelNumbers) => {
	mkdirSync(path.dirname(FILE), { recursive: true })
	writeFileSync(FILE, JSON.stringify(f, null, 2) + '\n')
}
export const loadFeel = (): FeelNumbers => JSON.parse(readFileSync(FILE, 'utf8'))
