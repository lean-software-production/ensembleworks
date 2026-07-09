// EnsembleWorks Discord bot — entry point.
// v1 wiring (adapter → router → registry → handlers) is added in later tasks;
// this stub just proves the workspace runs.
const PORT = Number(process.env.PORT ?? 8790)
console.log(`[discord] bot service starting (internal port ${PORT})`)
// Keep the process alive (no work yet).
setInterval(() => {}, 1 << 30)
