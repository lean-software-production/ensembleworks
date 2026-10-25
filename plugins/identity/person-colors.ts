import { personColor } from "./ownership-labels.js";

/**
 * Person colours: the colour format people may CHOOSE, and the legibility rules that
 * make any choice safe to render.
 *
 * `personColor` (ownership-labels.ts) deals a hue by roster position — the starting
 * point. This module is the override half: a person may pick a colour, it is stored, and
 * it wins wherever a person's colour is resolved.
 *
 * Pure functions, no storage and no DOM, so the rules are testable on their own.
 *
 * ## The stored format, and why
 *
 * **Lowercase `#rrggbb`, and nothing else.** A native `<input type="color">` emits
 * exactly that, so the normal path stores what it was handed; a three-digit hex or a
 * missing `#` is accepted and expanded, because the RPC is also reachable from a script.
 * Everything else — `rgb()`, `hsl()`, a named colour, a CSS fragment — is REFUSED rather
 * than stored: these strings end up in a `style` attribute and in a `box-shadow`, so a
 * value that is not provably a colour is not a value worth keeping. One canonical form
 * also makes equality and the clash check trivial.
 *
 * ## Legibility: adapt the ink, do not constrain the fill
 *
 * The badge draws a person's initials on their colour. `personColor`'s dealt hues are
 * fixed at `55% 38%` precisely so white always reads on them — but a person picking from
 * a colour wheel will pick pale yellow sooner or later, and white initials on pale yellow
 * are invisible.
 *
 * Two ways out: clamp what a person may pick, or choose the ink to suit what they picked.
 * **We choose the ink.** Clamping would quietly move someone's colour away from the one
 * they chose — the feature is "the colour associated with them", and silently answering
 * with a different colour is the one thing it must not do. Picking the ink costs nothing,
 * keeps every choice exactly as chosen, and is checkable: `readableInk` returns whichever
 * of white or near-black has the better WCAG contrast against the fill, and a test walks
 * a grid of every colour a person could pick and asserts the winner always clears
 * `MIN_INK_CONTRAST`.
 */

export type Rgb = { r: number; g: number; b: number };

/** The ink on a dark fill. */
export const LIGHT_INK = "#ffffff";
/** The ink on a light fill. Not pure black: it reads as ink rather than as a hole. */
export const DARK_INK = "#111827";

/**
 * The contrast ratio the better ink is guaranteed to clear, on ANY fill — MEASURED, not
 * hoped for.
 *
 * Walking the whole 8-bit colour cube (every third value per channel) and taking the
 * better of `LIGHT_INK` and `DARK_INK` on each, the minimum is **4.212**, at `#9f66ae`
 * and its neighbours: a band of mid-saturation violets that is too light for white and
 * too dark for near-black. So 4.2 is the honest floor, and it is stated rather than
 * rounded up to a WCAG number it does not meet.
 *
 * What that buys, plainly: WCAG AA for large/bold text (3:1) EVERYWHERE, and AA for
 * normal text (4.5:1) everywhere except that violet band, where it lands at 4.2. The
 * badge's own text is 9px bold, so it is "normal text" by WCAG's reckoning and that band
 * is a real, narrow shortfall.
 *
 * The comparison that matters is with what this replaced: fixed white ink, which is
 * 1.0:1 on a white pick and only 3.14:1 on the dealt yellow seat — invisible and
 * sub-AA respectively. Adapting the ink raises the floor from "unreadable" to 4.2.
 */
export const MIN_INK_CONTRAST = 4.2;

/**
 * How close two colours may be before the UI calls it a clash.
 *
 * Measured with the "redmean" weighted RGB distance below, whose range is 0 to ~765. The
 * threshold is deliberately generous: this only ever produces a WARNING (the owner's
 * answer to collisions is information, not prevention), so a false positive costs a
 * sentence and a false negative costs the whole point of the feature.
 */
export const CLASH_DISTANCE = 64;

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
const HSL = /^hsl\(\s*(-?[\d.]+)(?:deg)?\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%\s*\)$/i;

/**
 * Bring a chosen colour into the stored format, or refuse it.
 *
 * Returns lowercase `#rrggbb`, or null for anything this cannot prove is a colour.
 */
export function normalizeColorChoice(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  // Bound before matching: a pathological input should not reach the regex at all.
  if (trimmed.length === 0 || trimmed.length > 7) return null;
  const match = HEX.exec(trimmed);
  if (match === null) return null;
  const digits = match[1]!.toLowerCase();
  const full = digits.length === 3 ? digits.split("").map((d) => d + d).join("") : digits;
  return `#${full}`;
}

/**
 * Read any colour this plugin can produce — the stored `#rrggbb` AND the `hsl(h s% l%)`
 * that `personColor` deals — into channels, so a chosen colour and a dealt one can be
 * compared. Null for anything else, including the `var(--muted-foreground, …)` used for
 * "nobody", which has no numeric value here.
 */
export function parseCssColor(input: string | null | undefined): Rgb | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  const hex = normalizeColorChoice(trimmed);
  if (hex !== null) {
    return {
      r: Number.parseInt(hex.slice(1, 3), 16),
      g: Number.parseInt(hex.slice(3, 5), 16),
      b: Number.parseInt(hex.slice(5, 7), 16),
    };
  }
  const hsl = HSL.exec(trimmed);
  if (hsl === null) return null;
  const hue = ((Number.parseFloat(hsl[1]!) % 360) + 360) % 360;
  const saturation = Math.min(100, Math.max(0, Number.parseFloat(hsl[2]!))) / 100;
  const lightness = Math.min(100, Math.max(0, Number.parseFloat(hsl[3]!))) / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const base = lightness - chroma / 2;
  const sector = Math.floor(hue / 60) % 6;
  const [r, g, b] = ([
    [chroma, second, 0],
    [second, chroma, 0],
    [0, chroma, second],
    [0, second, chroma],
    [second, 0, chroma],
    [chroma, 0, second],
  ][sector] ?? [0, 0, 0]) as [number, number, number];
  const channel = (value: number) => Math.round((value + base) * 255);
  return { r: channel(r), g: channel(g), b: channel(b) };
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance(color: Rgb): number {
  const channel = (raw: number) => {
    const value = Math.min(255, Math.max(0, raw)) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** The WCAG contrast ratio between two colours, or null when either is unreadable. */
export function contrastRatio(a: string, b: string): number | null {
  const left = parseCssColor(a);
  const right = parseCssColor(b);
  if (left === null || right === null) return null;
  const lighter = Math.max(relativeLuminance(left), relativeLuminance(right));
  const darker = Math.min(relativeLuminance(left), relativeLuminance(right));
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The ink to draw on `fill`: whichever of white and near-black reads better on it.
 *
 * An unreadable fill answers white, which is what the badge has always used and what
 * every dealt colour is tuned for.
 */
export function readableInk(fill: string): string {
  const onLight = contrastRatio(DARK_INK, fill);
  const onDark = contrastRatio(LIGHT_INK, fill);
  if (onLight === null || onDark === null) return LIGHT_INK;
  return onLight > onDark ? DARK_INK : LIGHT_INK;
}

/**
 * How far apart two colours look, by the "redmean" weighted RGB distance — a cheap
 * approximation of perceptual difference that is much closer to the eye than plain
 * Euclidean RGB. Null when either colour cannot be read.
 */
export function colorDistance(a: string, b: string): number | null {
  const left = parseCssColor(a);
  const right = parseCssColor(b);
  if (left === null || right === null) return null;
  const meanRed = (left.r + right.r) / 2;
  const dr = left.r - right.r;
  const dg = left.g - right.g;
  const db = left.b - right.b;
  return Math.sqrt(
    (2 + meanRed / 256) * dr * dr + 4 * dg * dg + (2 + (255 - meanRed) / 256) * db * db,
  );
}

/**
 * Do these two read as the same colour? A WARNING only — nothing refuses a clash, because
 * the owner's answer to a collision is information, not prevention.
 *
 * An unreadable colour never clashes: claiming a clash it could not actually see would be
 * worse than saying nothing.
 */
export function colorsClash(a: string, b: string): boolean {
  const distance = colorDistance(a, b);
  return distance !== null && distance <= CLASH_DISTANCE;
}

/** A person's colour: what to render, and whether it was chosen or dealt. */
export type ResolvedColor = { color: string; overridden: boolean; dealt: string };

/**
 * A person's colour, with the override applied.
 *
 * The dealt hue is the starting point; a stored choice wins. An override that no longer
 * normalises (written by an older or buggier version, or corrupted) is IGNORED rather
 * than rendered — the stored string reaches a `style` attribute, so it must be re-proved
 * on the way out as well as on the way in.
 */
/** A fill as `#rrggbb`, whatever CSS colour form it arrives in. Null if unparseable. */
export function toHex(color: string | null | undefined): string | null {
  const rgb = parseCssColor(color);
  if (rgb === null) return null;
  const channel = (value: number) => Math.min(255, Math.max(0, Math.round(value))).toString(16).padStart(2, "0");
  return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`;
}

/**
 * The value a native `<input type="color">` may be handed for a person.
 *
 * ALWAYS `#rrggbb`. The element cannot hold anything else, and handing it an `hsl()`
 * string — which is what a DEALT colour always is — does not merely look wrong: the
 * browser coerces the value, React restores the stale prop between the `input` and
 * `change` events a native picker fires in one tick, and the coerced colour is written
 * back as though the person had chosen it. That was reproduced live: a turquoise pick
 * became the hex of the person's dealt hue, recorded as "chosen", with an audit line for
 * a change nobody made. A browser that coerced to `#000000` instead would turn every such
 * pick black.
 *
 * The fallback is the dealt colour converted, not a neutral stand-in, so the picker still
 * opens on the colour actually in force — which is what the surrounding copy promises.
 */
export function colorInputValue(row: { color: string; dealt: string }): string {
  return toHex(row.color) ?? toHex(row.dealt) ?? DARK_INK;
}

/**
 * Whether a pick is worth sending. A write that changes nothing is not a write.
 *
 * The second half of the defence above: `colorInputValue` stops the browser coercing a
 * value it cannot hold, and this stops a duplicate event storing what is already in force
 * — including an un-overridden person "picking" their own dealt colour, which is not a
 * choice and must not flip them to `overridden`.
 */
export function shouldCommitColor(row: { color: string; dealt: string }, picked: string): boolean {
  const next = normalizeColorChoice(picked);
  if (next === null) return false;
  return next !== colorInputValue(row);
}

export function resolvePersonColor(
  person: string | null,
  roster: readonly string[],
  overrides: Readonly<Record<string, string>>,
): ResolvedColor {
  const dealt = personColor(person, roster);
  if (person === null) return { color: dealt, overridden: false, dealt };
  const chosen = normalizeColorChoice(overrides[person]);
  if (chosen === null) return { color: dealt, overridden: false, dealt };
  return { color: chosen, overridden: true, dealt };
}
