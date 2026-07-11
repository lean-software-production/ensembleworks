export * from './types.js'
import { kernelTools } from './kernel.js'
import { avTools } from './av.js'
import { terminalTools } from './terminal.js'
import { canvasTools } from './canvas.js'
import { fileTools } from './file.js'
import { scribeTools } from './scribe.js'
import { roadmapTools } from './roadmap.js'
import { discordTools } from './discord.js'
export * from './kernel.js'; export * from './av.js'; export * from './terminal.js'
export * from './canvas.js'; export * from './file.js'; export * from './scribe.js'; export * from './roadmap.js'
export * from './discord.js'

/** The tool registry — every declared verb, in a stable order. */
export const allTools = [
	...kernelTools, ...avTools, ...terminalTools, ...canvasTools, ...fileTools, ...scribeTools, ...roadmapTools,
	...discordTools,
]
