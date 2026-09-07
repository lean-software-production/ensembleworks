// Which tree is each rule in the dock's stylesheet aimed at?
//
// WHY THIS EXISTS. The popover used to be a child of `#canvas-av-dock` and is
// now a child of `<body>` under an id of its own, because an ancestor's
// `overflow: hidden` was cutting it off at bb's pane boundary (the diagnosis,
// and how thin it is, are in canvas/dock/popover-place.ts's header). Every rule
// that reached a popover part through `#canvas-av-dock <something>` stopped
// matching the moment that happened, and there were two dozen of them. The
// failure of a missed one is silent and cosmetic — an unbordered button, a jump
// link that no longer ellipsises — which is exactly the kind a careful read
// does not reliably catch.
//
// So the question is asked mechanically, once per selector, by a parser small
// enough to be checked itself. NOTHING HERE RENDERS ANYTHING: there is no
// browser in this spike, so this cannot tell you the popover looks right, only
// that a rule naming its parts is pointed at the tree those parts live in.
// Specificity, cascade order and inheritance are all outside what it sees.
//
// THE PARSER IS DELIBERATELY NOT A CSS PARSER. It handles the shape this one
// sheet has — comments, flat rules, selector lists, declarations containing
// braces inside `min()`/`calc()`, and at-rule blocks in case somebody later
// wraps a media query around part of it. It does not handle strings containing
// braces or CSS nesting, because the sheet has neither; a sheet that grew them
// would need this widened rather than trusted.

/** One style rule: the selectors that open it, and the text between its
 * braces. `declarations` is raw — the property/value pairs as written, with
 * comments already gone. */
export interface CssRule {
  readonly selectors: readonly string[];
  readonly declarations: string;
}

/**
 * Every style rule in the sheet, selector lists split apart and whitespace
 * collapsed.
 *
 * Collapsing matters: the sheet wraps long selectors across lines, and the twin
 * check below compares selectors as strings, so a mirrored rule that happened
 * to be wrapped differently from its twin would read as missing.
 *
 * A RULE IS EMITTED WHEN IT CLOSES, not when it opens, which is what lets the
 * declarations come with it. For this sheet — flat rules, no nesting — that is
 * the same order as before; a nested rule would close before its at-rule, and
 * an at-rule emits nothing of its own, so the order is unchanged there too.
 */
export function rulesIn(css: string): readonly CssRule[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  const rules: CssRule[] = [];
  // One entry per open block: its selectors, or null for a block that has none
  // (an at-rule). A stack rather than a depth counter because the declarations
  // now have to be handed back to the block they belong to.
  const open: (readonly string[] | null)[] = [];
  let pending = "";

  for (const char of withoutComments) {
    if (char === "{") {
      // Only a block's brace gets here; the ones inside a declaration
      // (`min(80vw, 420px)` has none, but `calc()` and future nesting could)
      // are round.
      const prelude = pending.trim().replace(/\s+/g, " ");
      // An at-rule's prelude is not a selector — but the rules INSIDE it are,
      // which is why nothing here is gated on nesting depth. A parser that only
      // looked at the top level would report nothing at all for a sheet
      // somebody wrapped in a media query: a green audit that checked nothing,
      // which is worse than a red one.
      const selectors =
        prelude === "" || prelude.startsWith("@")
          ? null
          : prelude
              .split(",")
              .map((part) => part.trim())
              .filter((part) => part !== "");
      open.push(selectors);
      pending = "";
      continue;
    }
    if (char === "}") {
      // `?? null` covers a stray closing brace, which leaves the stack empty
      // rather than throwing. A malformed sheet should audit badly, not crash.
      const selectors = open.pop() ?? null;
      if (selectors !== null) rules.push({ selectors, declarations: pending });
      pending = "";
      continue;
    }
    pending += char;
  }

  return rules;
}

/**
 * Every selector in the sheet, one per entry.
 *
 * Kept as its own name because that is what the audit below asks for, and
 * because it is the shape every existing caller and test already reads.
 */
export function selectorsIn(css: string): readonly string[] {
  const selectors: string[] = [];
  for (const rule of rulesIn(css)) selectors.push(...rule.selectors);
  return selectors;
}

/**
 * The property names declared directly on the rules that name `selector`.
 *
 * Directly is the whole of it: this reports what the RULE says, and knows
 * nothing about the cascade, about shorthands expanding into longhands, or
 * about a value being `inherit`. It exists to answer one question — did this
 * sheet bother to state this property on this element — which is a question
 * about the text, and the only one a project with no browser can answer
 * honestly.
 *
 * The selector is matched as written, after the same whitespace collapse
 * `rulesIn` applies, so `#a .b` finds a rule wrapped across two lines. It is
 * not a matcher: `#a` does not find `#a .b`, because "declared on this element"
 * and "declared on something inside it" are different claims.
 */
export function propertiesOn(css: string, selector: string): readonly string[] {
  const wanted = selector.trim().replace(/\s+/g, " ");
  const properties: string[] = [];
  for (const rule of rulesIn(css)) {
    if (!rule.selectors.includes(wanted)) continue;
    for (const declaration of rule.declarations.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon === -1) continue;
      const property = declaration.slice(0, colon).trim().toLowerCase();
      if (property !== "") properties.push(property);
    }
  }
  return properties;
}

/**
 * Which of these roots does not establish its own typography?
 *
 * WHY A ROOT HAS TO. This sheet is deliberately self-contained and
 * theme-neutral — the header of canvas/dock/styles.ts says so, and the reason
 * is that bb's typography and CSS variables are not a contract offered to
 * plugins. Every tree it styles is rooted at an element whose PARENT is bb's
 * DOM, so an inheritable property the sheet does not declare at the root is a
 * property taken from the host. Font is the one that matters and the one that
 * is actually relied on: `.dock-btn` says `font: inherit` outright, and
 * `.dock-jump` and `.dock-status` set a size with no family.
 *
 * THIS IS THE FAILURE THE SCOPE AUDIT ABOVE CANNOT SEE, and it is how the
 * popover's move to <body> broke without a single wrong-looking selector: every
 * rule was re-rooted correctly, and the box still lost the
 * `font: 12px/1.35 …` it had been inheriting from `#canvas-av-dock` all along.
 * Scope is about which elements a rule reaches; this is about what an element
 * is given when no rule reaches it.
 *
 * `font` OR `font-family` counts. The shorthand is what this sheet uses, the
 * longhand is what someone would reasonably reach for instead, and either one
 * ends the dependency on the host's family. `font-size` alone does NOT count:
 * a size without a family still leaves the family inherited, which is the half
 * of the problem that shows up as "the popover is in bb's font".
 */
export function rootsWithoutOwnFont(
  css: string,
  roots: readonly string[],
): readonly string[] {
  return roots.filter((root) => {
    const properties = propertiesOn(css, root);
    return !properties.includes("font") && !properties.includes("font-family");
  });
}

/** The first compound in a selector — everything up to the first combinator. */
function firstCompound(selector: string): string {
  const match = /^[^\s>+~]+/.exec(selector.trim());
  return match === null ? "" : match[0];
}

/**
 * Is this selector rooted at `root`?
 *
 * `root` is an id selector, and the check is on the FIRST compound only: a rule
 * is "in" a tree when its leftmost element is that tree's root, which is the
 * only arrangement that guarantees it can never match outside it.
 *
 * THE PREFIX TRAP IS THE REASON THIS IS A FUNCTION. The two roots here are
 * `#canvas-av-dock` and `#canvas-av-dock-popover`, and the second starts with
 * the first — so `selector.startsWith(root)` calls every popover rule correctly
 * scoped under the strip's root, and the audit passes over a completely broken
 * sheet. What follows the root has to be a character that cannot continue an
 * identifier: a combinator, an attribute, a pseudo, a class, or nothing.
 */
export function isScopedUnder(selector: string, root: string): boolean {
  const compound = firstCompound(selector);
  if (!compound.startsWith(root)) return false;
  const rest = compound.slice(root.length);
  return rest === "" || !/^[\w-]/.test(rest);
}

/**
 * Does this selector name that class?
 *
 * The lookahead is not decoration: `.dock-jump-inert` must not answer for
 * `.dock-jump`, or a rule would classify as every class it happens to be a
 * prefix of and the whole partition below would be arbitrary. The leading `\.`
 * is what keeps an attribute VALUE that quotes a class name from counting.
 */
export function mentionsClass(selector: string, className: string): boolean {
  return new RegExp(`\\.${className}(?![\\w-])`).test(selector);
}

/**
 * Every rule in the sheet that is aimed at the wrong tree, as sentences.
 *
 * THE PARTITION, and it is the whole of the policy:
 *
 *   * A selector naming a POPOVER-ONLY class must be rooted at the popover.
 *   * A selector naming a STRIP-ONLY class must be rooted at the strip. This
 *     wins over the shared rule below, which is what lets the squeeze tiers
 *     (`#root .dock-strip .dock-bubble`) name a shared class without being
 *     asked for a popover twin that would style an element that cannot exist.
 *   * A selector naming a SHARED class and nothing tree-specific must exist
 *     under BOTH roots — as a two-selector list or as two rules, this does not
 *     care which. This is the case with no wrong-looking selector to point at:
 *     `.dock-bubble`'s base rule kept its strip scope and looked perfectly
 *     reasonable while the popover's faces silently lost their border-radius,
 *     their overflow clip and their separator ring.
 *   * A selector naming a popover-only AND a strip-only class is a rule that
 *     cannot match anything, whichever root it has.
 *   * A selector naming none of the three lists is not this function's
 *     business — the sidebar row decorations, and the roots' own rules.
 *
 * The three lists are the caller's, and they are knowledge from
 * canvas/dock/dock.ts rather than from the sheet: which classes that file
 * builds inside the popover and which inside the strip. That is what stops this
 * being a file checked against itself, and it is also the limit — a class this
 * has never been told about is a class it cannot judge.
 */
export function auditDockScopes(input: {
  readonly css: string;
  readonly stripRoot: string;
  readonly popoverRoot: string;
  readonly popoverOnly: readonly string[];
  readonly stripOnly: readonly string[];
  readonly shared: readonly string[];
}): readonly string[] {
  const { css, stripRoot, popoverRoot, popoverOnly, stripOnly, shared } = input;
  const selectors = selectorsIn(css);
  const present = new Set(selectors);
  const complaints: string[] = [];

  for (const selector of selectors) {
    const isPopoverPart = popoverOnly.some((name) => mentionsClass(selector, name));
    const isStripPart = stripOnly.some((name) => mentionsClass(selector, name));

    if (isPopoverPart && isStripPart) {
      complaints.push(
        `${selector} — names a popover part and a strip part, so it can never match`,
      );
      continue;
    }
    if (isPopoverPart) {
      if (!isScopedUnder(selector, popoverRoot)) {
        complaints.push(`${selector} — a popover part, but not rooted at ${popoverRoot}`);
      }
      continue;
    }
    if (isStripPart) {
      if (!isScopedUnder(selector, stripRoot)) {
        complaints.push(`${selector} — a strip part, but not rooted at ${stripRoot}`);
      }
      continue;
    }
    if (!shared.some((name) => mentionsClass(selector, name))) continue;

    // A shared part. Whichever root it has, the other one has to be there too.
    const twin = twinOf(selector, stripRoot, popoverRoot);
    if (twin === null) {
      complaints.push(
        `${selector} — a shared part, but rooted at neither ${stripRoot} nor ${popoverRoot}`,
      );
      continue;
    }
    if (!present.has(twin)) {
      complaints.push(`${twin} — missing: a shared part that reaches only one of the two trees`);
    }
  }

  // Sorted and de-duplicated: a missing twin is reported once however many
  // selectors ask for it, and a run of complaints is easier to read against the
  // sheet in a stable order. `null` for a selector rooted at neither.
  return Array.from(new Set(complaints)).sort();
}

function twinOf(selector: string, stripRoot: string, popoverRoot: string): string | null {
  // Popover root first. THE ORDER IS NOT LOAD-BEARING AS THIS IS WRITTEN, and
  // saying so is the point: `isScopedUnder` already refuses `#canvas-av-dock`
  // for `#canvas-av-dock-popover .x` (its boundary check is exactly that trap),
  // so swapping these two branches leaves every test green — checked, not
  // assumed. It is written this way round so the function stays correct on its
  // own if that check is ever loosened to a plain `startsWith`, under which the
  // strip-first order would rewrite `#canvas-av-dock-popover .x` into
  // `#canvas-av-dock-popover-popover .x` and report a twin nobody could write.
  if (isScopedUnder(selector, popoverRoot)) {
    return stripRoot + selector.slice(popoverRoot.length);
  }
  if (isScopedUnder(selector, stripRoot)) {
    return popoverRoot + selector.slice(stripRoot.length);
  }
  return null;
}
