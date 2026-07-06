/**
 * Output discipline (spec §7.1): stdout is ALWAYS clean — either a data verb's
 * verbatim server response, or an operator verb's requested human/JSON view.
 * Every diagnostic, prompt, warning and progress line goes to stderr via
 * narrate(). (Mirrors the `bin/dev … --json` convention in CLAUDE.md.)
 */
export function emitData(body: string): void {
	process.stdout.write(body.endsWith('\n') ? body : `${body}\n`)
}

export function emitJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

export function emitLine(line: string): void {
	process.stdout.write(`${line}\n`)
}

export function narrate(line: string): void {
	process.stderr.write(`${line}\n`)
}

export function emitTable(headers: string[], rows: string[][]): void {
	const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
	const fmt = (cells: string[]) => cells.map((c, i) => (c ?? '').padEnd(widths[i] ?? 0)).join('  ').trimEnd()
	emitLine(fmt(headers))
	for (const r of rows) emitLine(fmt(r))
}
