// The interaction-script DSL: build a deterministic InputEvent[] with a
// fluent builder instead of hand-assembling event objects in every test.
// "Deterministic" here means literally: two `script(sameOpts).sameCalls()`
// invocations produce arrays that are isDeepStrictEqual, because every
// timestamp is derived from `startT`/`dt` (never a real clock) and every
// interpolated point is a pure linear function of its two named endpoints —
// there is no hidden state that could vary between builds. This is what
// lets a QA session or a bug report serialize into a script and become a
// regression test (the design's replay principle; the full session-replay
// harness lands in C9 — this is the primitive it replays through).
import type { InputEvent, Modifiers } from './input.js'
import type { Editor } from './editor.js'
import type { Tool } from './input.js'

const DEFAULT_MODIFIERS: Modifiers = { shift: false, alt: false, ctrl: false, meta: false }

export interface StepOptions {
  readonly modifiers?: Partial<Modifiers>
}
export interface MoveOptions extends StepOptions {
  /** Number of INTERMEDIATE points to interpolate between the previous
   * position and (x, y), linearly spaced (not counting the final landing
   * point at (x, y) itself, which is always emitted). 0 (the default) emits
   * just the landing point — a "jump", no interpolation. */
  readonly steps?: number
}
export interface WheelOptions extends StepOptions {
  /** Screen point the wheel event fires at; defaults to the builder's
   * current pointer position (wherever the last down/move landed). */
  readonly at?: readonly [number, number]
}
export interface KeyOptions {
  readonly modifiers?: Partial<Modifiers>
  readonly type?: 'keydown' | 'keyup'
}

class ScriptBuilder {
  private readonly built: InputEvent[] = []
  private t: number
  private readonly dt: number
  private buttons = 0
  private x = 0
  private y = 0

  constructor(opts: { readonly startT?: number; readonly dt?: number }) {
    this.t = opts.startT ?? 0
    this.dt = opts.dt ?? 16
  }

  private modifiers(over?: Partial<Modifiers>): Modifiers { return { ...DEFAULT_MODIFIERS, ...over } }
  // Every emitted event consumes exactly one tick, unconditionally — this is
  // what guarantees MONOTONE, strictly-increasing timestamps regardless of
  // how many (if any) interpolation steps a .move() call uses: even
  // `steps: 0` (no intermediate points) still advances `t` by `dt` for the
  // single landing-point event, and `steps: 1` advances it once per
  // intermediate point plus once more for the landing point.
  private tick(): number { const cur = this.t; this.t += this.dt; return cur }

  down(x: number, y: number, opts: StepOptions & { readonly buttons?: number } = {}): this {
    this.buttons = opts.buttons ?? 1
    this.x = x; this.y = y
    this.built.push({ type: 'pointerdown', x, y, buttons: this.buttons, modifiers: this.modifiers(opts.modifiers), t: this.tick() })
    return this
  }

  /** Move from the builder's current position to (x, y), emitting
   * `opts.steps` linearly-interpolated intermediate points (fraction
   * i/(steps+1) of the way there, for i in 1..steps) followed by the exact
   * landing point — steps+1 pointermove events total, each on its own tick. */
  move(x: number, y: number, opts: MoveOptions = {}): this {
    const steps = opts.steps ?? 0
    const x0 = this.x, y0 = this.y
    const modifiers = this.modifiers(opts.modifiers)
    for (let i = 1; i <= steps; i++) {
      const frac = i / (steps + 1)
      const ix = x0 + (x - x0) * frac
      const iy = y0 + (y - y0) * frac
      this.built.push({ type: 'pointermove', x: ix, y: iy, buttons: this.buttons, modifiers, t: this.tick() })
    }
    this.x = x; this.y = y
    this.built.push({ type: 'pointermove', x, y, buttons: this.buttons, modifiers, t: this.tick() })
    return this
  }

  up(opts: StepOptions & { readonly buttons?: number } = {}): this {
    const buttons = opts.buttons ?? 0
    this.built.push({ type: 'pointerup', x: this.x, y: this.y, buttons, modifiers: this.modifiers(opts.modifiers), t: this.tick() })
    this.buttons = buttons
    return this
  }

  key(key: string, opts: KeyOptions = {}): this {
    this.built.push({ type: opts.type ?? 'keydown', key, modifiers: this.modifiers(opts.modifiers), t: this.tick() })
    return this
  }

  wheel(dx: number, dy: number, opts: WheelOptions = {}): this {
    const [x, y] = opts.at ?? [this.x, this.y]
    this.built.push({ type: 'wheel', x, y, dx, dy, modifiers: this.modifiers(opts.modifiers), t: this.tick() })
    return this
  }

  /** The finished, immutable event sequence — a fresh array each call so a
   * caller mutating the returned array can't corrupt the builder's own
   * record. */
  events(): InputEvent[] { return [...this.built] }
}

/** Start building an interaction script. `startT`/`dt` are both injected
 * (default startT: 0, dt: 16 — one 60fps-ish frame) so two scripts built
 * with the same opts and the same call sequence produce identical
 * InputEvent[] arrays, satisfying the package-wide determinism rule. */
export function script(opts: { readonly startT?: number; readonly dt?: number } = {}): ScriptBuilder {
  return new ScriptBuilder(opts)
}

/**
 * The minimal dispatch loop: feed `events` to `tool.onEvent` one at a time,
 * starting from `tool.initialState`, applying every event's returned
 * Intents to `editor` via ONE `editor.applyAll()` call per EVENT (so a
 * single event's intents share one doc.commit()/store-notification, per
 * editor.ts's commit-granularity rule — see run()'s test for what that
 * means for a multi-event gesture). Returns the tool's final FSM state
 * after the last event. Skips the applyAll() call entirely for an event
 * that returns zero intents (a no-op batch would be harmless, but skipping
 * it makes "this event changed nothing" observable to a doc.subscribe()
 * listener too).
 */
export function run<S>(editor: Editor, tool: Tool<S>, events: readonly InputEvent[]): S {
  let state = tool.initialState
  for (const event of events) {
    const result = tool.onEvent(state, event)
    state = result.state
    if (result.intents.length > 0) editor.applyAll(result.intents)
  }
  return state
}
