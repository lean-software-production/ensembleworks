/**
 * Test-support fake of the Cloudflare Access surfaces the CLI talks to (SP5).
 * NEVER imported by production code; not matched by the *.test.ts discovery
 * glob, so it is a plain module, not a suite.
 */

/** An unsigned-but-well-formed JWT (we only ever DECODE payloads client-side —
 *  Discovery #5: the edge is the verifier). */
export function makeJwt(payload: Record<string, unknown>): string {
	const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
	return `${enc({ alg: 'RS256', kid: 'fake-kid' })}.${enc(payload)}.${Buffer.from('fake-sig').toString('base64url')}`
}
