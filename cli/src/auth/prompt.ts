/** Interactive prompts on stderr (stdout stays clean). askSecret reads without
 *  echo from a tty; on a non-tty (CI) it falls back to a plain line read. */
import { createInterface } from 'node:readline'

export async function ask(question: string, fallback = ''): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stderr })
	try {
		const answer = await new Promise<string>((resolve) => rl.question(question, resolve))
		return answer.trim() || fallback
	} finally {
		rl.close()
	}
}

export async function askSecret(question: string): Promise<string> {
	const stdin = process.stdin
	if (!stdin.isTTY) return ask(question)
	process.stderr.write(question)
	return new Promise<string>((resolve) => {
		const chunks: string[] = []
		const wasRaw = stdin.isRaw
		stdin.setRawMode(true)
		stdin.resume()
		const onData = (buf: Buffer) => {
			for (const ch of buf.toString('utf8')) {
				if (ch === '\n' || ch === '\r' || ch === '\u0004') {
					stdin.setRawMode(wasRaw)
					stdin.pause()
					stdin.removeListener('data', onData)
					process.stderr.write('\n')
					return resolve(chunks.join(''))
				}
				if (ch === '\u0003') process.exit(130) // Ctrl-C
				else if (ch === '\u007f') chunks.pop() // backspace
				else chunks.push(ch)
			}
		}
		stdin.on('data', onData)
	})
}
