// Session recording + deterministic replay: the interleaving that
// determines a session is EXACTLY the sequence of {local input, remote
// import, tool switch} events, in the order they actually happened — this
// file records that sequence into a JSON-serializable Session and can
// reconstruct an equivalent Editor/doc from it, deterministically.
//
// DETERMINISM CONTRACT (the whole point of this file, read this before
// wiring it up): a REAL live session's Editor must be constructed with
// `now`/`random` DERIVED FROM A SEED (deriveEditorClock below), not a real
// wall clock/Math.random — the seed itself comes from wherever real entropy
// lives (G3's problem, out of this package's scope per the boundary rule:
// this file never reads a wall clock or the host's random-number source
// directly either). That seed is
// recorded once, in SessionMeta, and is the ONLY source of "randomness" a
// replay needs: replaySession calls the SAME deriveEditorClock(seed) to
// reconstruct byte-identical now()/random() sequences. Recording a session
// whose LIVE editor used a real, unseeded now/random cannot be replayed
// bit-for-bit — there would be no way to reconstruct what the host's random
// source actually returned during the original run. This is a real constraint the
// live-session wiring (Seam D/G3) must honor, not just a testing nicety.
import { LoroCanvasDoc, type CanvasDoc } from '@ensembleworks/canvas-doc'
import { Editor } from './editor.js'
import type { InputEvent, Tool } from './input.js'

// ============================================================================
// mulberry32: a small, well-known public-domain PRNG (32-bit state, one
// multiply-heavy mix per draw) — inlined per the boundary rule (this file
// may never call Math.random itself). Two independent streams are derived
// per session (see deriveEditorClock) so a tool consuming `random()` for id
// generation isn't perturbed by how many times something else calls
// `now()`, or vice versa.
// ============================================================================
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function (): number {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// A fixed epoch (never read off a real wall clock — this file never reads
// one, per the boundary rule) plus a
// small seed-derived positive increment per call: deterministic and
// monotonically increasing, "clock-shaped" for any future consumer, even
// though nothing in this package reads `editor.now()` today (editor.ts's own
// doc comment names it as a future consumer — a created shape's meta
// timestamp, double-click timing, etc).
const FIXED_EPOCH_MS = 1_700_000_000_000

/** Derive this session's `now`/`random` functions from its seed — see the
 * module header's DETERMINISM CONTRACT. Two independent mulberry32 streams
 * (seeded `seed` and `seed ^ 0x9e3779b9`, a common decorrelating XOR
 * constant — the golden-ratio-derived Fibonacci hashing constant, chosen
 * only to keep the two seeds visibly unrelated, not for any cryptographic
 * property). Calling this twice with the SAME seed always produces
 * functions with IDENTICAL output sequences — that's the entire point. */
export function deriveEditorClock(seed: number): { now: () => number; random: () => number } {
  const random = mulberry32(seed)
  const clockJitter = mulberry32(seed ^ 0x9e3779b9)
  let t = FIXED_EPOCH_MS
  const now = (): number => { t += 1 + Math.floor(clockJitter() * 20); return t }
  return { now, random }
}

// ============================================================================
// Base64 codec for Uint8Array — inlined rather than Buffer/btoa: this
// package targets an eventual browser bundle (canvas-react, Seam D) where
// Buffer needs a polyfill and btoa/atob operate on Latin1 "binary strings"
// with their own encode/decode ceremony either way, so a small dependency-
// free codec is simplest and equally portable to both runtimes.
// ============================================================================
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!, b1 = bytes[i + 1], b2 = bytes[i + 2]
    const chunk = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0)
    out += B64[(chunk >> 18) & 63]
    out += B64[(chunk >> 12) & 63]
    out += b1 !== undefined ? B64[(chunk >> 6) & 63] : '='
    out += b2 !== undefined ? B64[chunk & 63] : '='
  }
  return out
}

function base64ToBytes(b64: string): Uint8Array {
  const out: number[] = []
  let buffer = 0, bits = 0
  for (const ch of b64) {
    if (ch === '=') break
    const idx = B64.indexOf(ch)
    if (idx === -1) continue
    buffer = (buffer << 6) | idx
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 0xff)
    }
  }
  return new Uint8Array(out)
}

// ============================================================================
// Session schema
// ============================================================================

/** Bumped whenever Step/SessionMeta's shape changes in a way an OLDER
 * replaySession couldn't read — forward-compat for sessions persisted to
 * disk/a bug-report attachment across a later canvas-editor version. This
 * file only ever writes CURRENT_SESSION_VERSION and only ever reads it (no
 * migration table exists yet — the first format change is what earns one). */
export const CURRENT_SESSION_VERSION = 1 as const

export interface SessionMeta {
  readonly version: typeof CURRENT_SESSION_VERSION
  /** Decimal-string encoding of the bigint peerId (JSON has no bigint). */
  readonly peerId: string
  readonly pageId: string
  /** Seed for deriveEditorClock — see the module header's DETERMINISM
   * CONTRACT. A 32-bit unsigned integer (mulberry32's own domain); callers
   * minting a fresh seed for a new live session should keep it in that
   * range (e.g. `Math.floor(realRandomSource() * 2**32)`, sourced from
   * wherever G3 wires real entropy — never Math.random directly in THIS
   * package, per the boundary rule). */
  readonly seed: number
}

/** One recorded step. `input` carries the normalized InputEvent AND which
 * tool it was dispatched to (so replay can route it to the right FSM's
 * onEvent without needing a separate "current tool" bookkeeping pass —
 * `toolSwitch` steps are then purely informational/human-readable, not
 * load-bearing for replay's own dispatch). `remote` carries an imported
 * update's bytes as base64 (a Uint8Array is not JSON-serializable). */
export type Step =
  | { readonly kind: 'input'; readonly event: InputEvent; readonly tool: string }
  | { readonly kind: 'remote'; readonly bytes: string }
  | { readonly kind: 'toolSwitch'; readonly tool: string }

export interface Session {
  readonly meta: SessionMeta
  readonly steps: readonly Step[]
}

// ============================================================================
// Recording
// ============================================================================

/**
 * Records the full interleaving that determines a session. RECORDING HOOKS
 * (the task spec's own division of labor):
 *   - Local inputs: wrap a Tool with `recorder.wrap(tool, toolName)` and
 *     drive the WRAPPED tool through script.ts's `run()` exactly as before
 *     — wrapping is a transparent decorator (same Tool<S> interface), so no
 *     change to the run() loop itself is needed. Call `recorder.switchTool`
 *     when the user switches to a different tool (purely informational —
 *     see Step's doc comment).
 *   - Remote updates: the sync wiring (G3) calls `recorder.recordRemote(bytes)`
 *     alongside its own `doc.import(bytes)` — this file does not hook
 *     CanvasDoc.import itself (that would require the recorder to own or
 *     wrap the doc, coupling it to a specific CanvasDoc instance; an
 *     explicit call at the sync layer is simpler and keeps this class doc-
 *     agnostic, matching Tool.wrap's own "decorate, don't own" shape).
 *
 * SCOPE: intended for test/debug-scoped sessions (E2E failure capture,
 * bug-report repros), not a long-running production log — `steps` grows
 * without bound for the recorder's lifetime, by design.
 */
export class SessionRecorder {
  private readonly meta: SessionMeta
  private readonly steps: Step[] = []

  constructor(meta: SessionMeta) {
    this.meta = meta
  }

  /** Wrap `tool` so every event it processes is recorded under `toolName`
   * BEFORE being forwarded to the real tool — recording happens even if
   * the tool's own onEvent throws (defense in depth: a script/test replay
   * should still see the event that triggered a bug), by recording first,
   * calling second. */
  wrap<S>(tool: Tool<S>, toolName: string): Tool<S> {
    const steps = this.steps
    return {
      initialState: tool.initialState,
      onEvent: (state: S, event: InputEvent) => {
        steps.push({ kind: 'input', event, tool: toolName })
        return tool.onEvent(state, event)
      },
    }
  }

  /** Record a tool switch (informational — see Step's doc comment; does
   * NOT affect which tool a subsequent input step dispatches to, since each
   * input step names its own tool directly). */
  switchTool(toolName: string): void {
    this.steps.push({ kind: 'toolSwitch', tool: toolName })
  }

  /** Record a remote update's raw bytes, at import time — see this class's
   * own doc comment for why the caller (not this file) calls doc.import. */
  recordRemote(bytes: Uint8Array): void {
    this.steps.push({ kind: 'remote', bytes: bytesToBase64(bytes) })
  }

  /** The recorded session so far — a fresh array each call (same "caller
   * can't corrupt the recorder's own record" discipline as script.ts's
   * ScriptBuilder.events()). JSON.stringify(session)/JSON.parse round-trips
   * losslessly: every field is already a plain JSON value (InputEvent is a
   * flat object of numbers/strings/booleans, `bytes` is a base64 string). */
  toSession(): Session {
    return { meta: this.meta, steps: [...this.steps] }
  }
}

// ============================================================================
// Replay
// ============================================================================

export interface ReplayResult {
  readonly editor: Editor
  readonly doc: CanvasDoc
}

/**
 * Reconstruct an equivalent Editor/doc from a recorded Session: a fresh
 * LoroCanvasDoc with the SAME peerId, an Editor built with the SAME
 * seed-derived now/random (deriveEditorClock — see the module header), and
 * every step applied IN ORDER — an `input` step is dispatched to
 * `buildTools(editor)[step.tool]`'s onEvent (per-tool FSM state threads
 * across that tool's OWN steps only, exactly as it would live if the user
 * switched away and back), a `remote` step is imported+committed, and a
 * `toolSwitch` step is a no-op here (see Step's doc comment — it carries no
 * information replay's dispatch needs, since every input step already names
 * its own tool).
 *
 * `buildTools` is a CALLBACK, not a pre-built map, because the tools it
 * returns must be built against THIS replay's own fresh editor (each tool
 * factory closes over a ToolContext, which closes over an Editor — see
 * tool-context.ts) — a chicken-and-egg this file resolves by handing the
 * caller the fresh `editor` to build against, e.g. `(editor) => { const ctx
 * = createToolContext(editor); return { select: createSelectTool(ctx),
 * arrow: createArrowTool(ctx), ... } }`, the SAME name -> tool mapping
 * convention the recording caller used with SessionRecorder.wrap. This file
 * does not hardcode which tool names exist or how a parameterized one (e.g.
 * create's note/text/geo/frame kinds) maps to a name; that convention
 * belongs entirely to the caller. A step naming an unregistered tool
 * throws — a caller-side wiring bug (an incomplete tools map), not a data
 * race the TOLERANCE CONTRACT (editor.ts's applyAll) is about, so it is NOT
 * silently skipped. The ToolContext `buildTools` creates is NOT disposed by
 * this function — a one-shot replay (debugging a bug report, a test) has no
 * further doc mutations coming after this call returns, so the leaked
 * doc.subscribe listener is harmless; a caller replaying repeatedly against
 * long-lived state should dispose its own ToolContext once done.
 *
 * `bootstrap`, if given, runs ONCE against the fresh editor/doc BEFORE any
 * recorded step — for pre-existing room infrastructure (e.g. the page(s) a
 * session's shapes attach to) that exists BEFORE recording starts and is
 * therefore deliberately NOT part of `Session.steps` (a page is root-level
 * room setup, not a per-session interaction). The caller must run the
 * IDENTICAL bootstrap it ran on the original recording doc before recording
 * began, as its own continuous LOCAL history (e.g. `(editor) => {
 * editor.doc.putPage(...); editor.doc.commit() }`), not as an imported
 * update — this is what keeps the op SEQUENCE (not just the converged
 * content) identical between recording and replay, which matters for
 * BYTE-level equality: an imported blob and an equivalent local commit are
 * not interchangeable IN GENERAL — in particular NEVER for a
 * DIFFERENT-peer donor, which is exactly the realistic pre-existing-room
 * case (the room's page was created by some other peer/the server, so its
 * ops carry that donor's peerId in the encoded history, unreproducible by
 * a local commit under the session's own peerId). A SAME-peer,
 * fresh-counter donor CAN coincidentally produce byte-identical results
 * (reviewer-constructed both ways) — but replay must not lean on that
 * coincidence, hence the rule: run the bootstrap identically as LOCAL
 * history on both sides (see replay.test.ts's bit-for-bit test, which
 * bootstraps this way on both sides for exactly this reason).
 */
export function replaySession(session: Session, buildTools: (editor: Editor) => Readonly<Record<string, Tool<unknown>>>, bootstrap?: (editor: Editor) => void): ReplayResult {
  const { now, random } = deriveEditorClock(session.meta.seed)
  const doc = LoroCanvasDoc.create({ peerId: BigInt(session.meta.peerId) })
  const editor = new Editor({ doc, now, random, pageId: session.meta.pageId })
  bootstrap?.(editor)
  const tools = buildTools(editor)

  const toolStates = new Map<string, unknown>()
  const stateFor = (toolName: string, tool: Tool<unknown>): unknown => {
    if (!toolStates.has(toolName)) toolStates.set(toolName, tool.initialState)
    return toolStates.get(toolName)
  }

  for (const step of session.steps) {
    if (step.kind === 'toolSwitch') continue
    if (step.kind === 'remote') {
      doc.import(base64ToBytes(step.bytes))
      doc.commit()
      continue
    }
    const tool = tools[step.tool]
    if (!tool) throw new Error(`replaySession: no tool registered for "${step.tool}"`)
    const state = stateFor(step.tool, tool)
    const result = tool.onEvent(state, step.event)
    toolStates.set(step.tool, result.state)
    if (result.intents.length > 0) editor.applyAll(result.intents)
  }

  return { editor, doc }
}
