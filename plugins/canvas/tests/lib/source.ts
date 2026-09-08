// Test-only source reading. Not shipped, not imported by any canvas/ module.
//
// WHY THIS EXISTS. There is no jsdom in this project (deliberately — see the
// spike README), so no test can mount CanvasPanel.tsx and watch an effect run.
// The strongest honest statement left about the panel is that it CALLS the
// pure decisions rather than re-deciding inline, and that statement is a
// source-text assertion.
//
// A source-text assertion is only worth its ability to fail. Reading the file
// as one flat string is not: this panel's own header comment spells out the
// call sequence it performs, so a guard for `resolvePageId(peer.doc,
// pageIdFromSubPath(` was satisfied by the PROSE and stayed green after the
// call itself was cut down to `resolvePageId(peer.doc)`. Comments must
// therefore be removed before any guard looks at the text.
//
// A regex stripper is not good enough either: `//` inside a string (a URL) or
// a template literal would make it eat real code, and a guard that has lost
// the line it is checking fails for the wrong reason — or, on a `not.toContain`
// assertion, passes for the wrong reason. So this uses TypeScript's own
// scanner via the parser: every comment in a TS/TSX file is trivia attached to
// some token, and blanking those ranges leaves the code byte-identical.
import ts from "typescript";

/**
 * `source` with every comment replaced by whitespace of the same length.
 *
 * Offsets are preserved (spaces, not deletion) so a match's index still points
 * at the same place in the original file, and so line numbers in a failure
 * message still mean something.
 */
export function stripComments(source: string): string {
  const file = ts.createSourceFile(
    "guarded.tsx",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );
  const ranges: ts.CommentRange[] = [];
  const visit = (node: ts.Node): void => {
    // Leading trivia of a token is where a comment lives; trailing catches the
    // `code; // note` form at the end of the last token on a line.
    for (const range of ts.getLeadingCommentRanges(source, node.pos) ?? []) {
      ranges.push(range);
    }
    for (const range of ts.getTrailingCommentRanges(source, node.end) ?? []) {
      ranges.push(range);
    }
    for (const child of node.getChildren(file)) visit(child);
  };
  visit(file);

  const out = source.split("");
  for (const range of ranges) {
    for (let i = range.pos; i < range.end && i < out.length; i += 1) {
      // Newlines survive so the stripped text keeps the original's line count.
      if (out[i] !== "\n" && out[i] !== "\r") out[i] = " ";
    }
  }
  return out.join("");
}

/** How many times `needle` appears in `source` OUTSIDE any comment. */
export function countInCode(source: string, needle: string): number {
  const code = stripComments(source);
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = code.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/**
 * The text between the parentheses of the FIRST `name(` call in `code`.
 *
 * WHY A GUARD NEEDS THIS AT ALL. A file-wide `toContain` cannot say WHERE a
 * value is passed, and the panel this is pointed at names
 * `currentPageId: editorState.currentPageId` at four different call sites — so
 * a file-wide assertion survives deleting it from the one that matters.
 * Bounding the assertion to one call's own argument list is what makes the
 * guard fail when that call loses the argument.
 *
 * Balanced-paren scan from the first `name(`, so a nested call in an argument
 * (`snapshot.pages.map((page) => page.id)`) does not end it early. It does NOT
 * understand parentheses inside strings or template literals — it is only ever
 * pointed at argument lists of identifiers, property shorthands and small
 * arrows, and callers assert the call appears exactly once first, so a scan
 * that ran off the end throws rather than silently returning the wrong span.
 *
 * Pass COMMENT-STRIPPED code: `stripComments` first, or a `(` in prose above
 * the call moves the match.
 */
export function callArguments(code: string, name: string): string {
  const open = code.indexOf(`${name}(`);
  if (open === -1) throw new Error(`no ${name}( call in the guarded code`);
  const from = open + name.length;
  let depth = 0;
  for (let i = from; i < code.length; i += 1) {
    if (code[i] === "(") depth += 1;
    else if (code[i] === ")") {
      depth -= 1;
      if (depth === 0) return code.slice(from + 1, i);
    }
  }
  throw new Error(`unbalanced parentheses after ${name}(`);
}

/** One real call expression found in a file: its source text and where it starts. */
export interface SourceCall {
  /** The whole call, callee and argument list — e.g. `foo.bar(baz)`. */
  readonly text: string;
  /** Offset of the call's first character in the source it was found in. */
  readonly pos: number;
}

/**
 * Every REAL call to `callee` in `source` — parsed, not text-matched.
 *
 * WHY THIS EXISTS, and it is not a convenience. `stripComments` above blanks
 * comments but deliberately NOT string literals: dozens of guards in this
 * project legitimately match string literals in the code they read
 * (`querySelectorAll("[data-canvas-page-tab]")`, `addEventListener("keydown"`,
 * `type: "move"`), so blanking strings globally would destroy them.
 *
 * That leaves a hole a `toMatch(/setPointerCapture\(event\.pointerId\)/)` guard
 * cannot close, and it was walked through on 2026-09-06: the real
 * `setPointerCapture` call was DELETED and replaced with
 * `const capture = "setPointerCapture(event.pointerId)"; void capture;`, and
 * the whole suite stayed green. A string is not a call, and only the parser
 * knows the difference.
 *
 * `callee` is matched against the callee's exact source text, so
 * `event.currentTarget.setPointerCapture` pins the RECEIVER too — a capture
 * taken on some other element is a different call, not this one.
 *
 * IT IS REACHABILITY-BLIND, and that limit is load-bearing: it reports every
 * call expression the parser can see, INCLUDING one inside a function nobody
 * invokes. Moving two `document.addEventListener` calls into
 * `const register = (): void => { … }; void register;` left an assertion built
 * on this helper exactly true while the tab menu bound nothing (2026-09-06).
 * For "does this actually run", ask `effectStatements` / `bodyStatements` /
 * `topLevelEffectIn` below for the statement LIST the code executes.
 */
export function callsTo(source: string, callee: string): readonly SourceCall[] {
  const file = ts.createSourceFile(
    "guarded.tsx",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );
  const found: SourceCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === callee) {
      found.push({ text: node.getText(file), pos: node.getStart(file) });
    }
    node.forEachChild(visit);
  };
  visit(file);
  return found;
}

/**
 * The text of the object literal `const <name>` is initialised to, braces
 * included — parsed, so the slice ends at the literal's OWN closing brace.
 *
 * WHY NOT `slice(indexOf(name), indexOf("};"))`: a nested object (a style with
 * a `:hover` block, a `transform` built from a template) ends the naive slice
 * early, and a guard bounded to a slice that stopped short passes for the wrong
 * reason on every `not.toMatch` beside it. Bounding a guard to exactly one
 * object literal is the whole point of having it.
 */
export function objectLiteralText(source: string, name: string): string {
  const file = ts.createSourceFile(
    "guarded.tsx",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );
  let text: string | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      text = node.initializer.getText(file);
    }
    node.forEachChild(visit);
  };
  visit(file);
  if (text === null) throw new Error(`no object literal named ${name} in the guarded code`);
  return text;
}

// ---------------------------------------------------------------------------
// STRUCTURE, NOT TEXT. Everything above answers "does this text appear?", and
// on 2026-09-06 a validator walked seven mutations of canvas/pages/
// PageSwitcher.tsx past a green suite that were all invisible to that question:
//
//   * a handler DISCONNECTED from the element that should call it
//     (`onClick={() => undefined}`, while the handler itself stayed perfect);
//   * a built node NEVER RENDERED (`{false ? tabMenu : null}`);
//   * a whole `useEffect` DELETED (dismissal, and separately focus-on-open);
//   * a computed answer THROWN AWAY (`if (back !== null) void back;`);
//   * a guard replaced by a DECOY CLOSURE that still contains the guard's exact
//     text (`const shape = () => { if (guard) return; }; void shape;`);
//   * a call re-aimed at a DIFFERENT ARGUMENT (`anchorOf(stripRef.current)` in
//     the tab menu's placement, so every menu opens in the corner).
//
// A second pass over the guards written for those then walked four MORE past a
// green suite, three of them the decoy again but aimed one level up from where
// each new guard looked:
//
//   * listeners moved out of a surviving effect into a decoy closure
//     (`const register = () => { document.addEventListener(…); }; void register;`)
//     — the menu registered nothing while `callsTo` stayed exactly true;
//   * the same on the drag's cancel listeners, past a guard that pinned only
//     the two handler BODIES — both perfect, neither attached;
//   * a whole `useLayoutEffect` wrapped in a decoy, past an EXACT match on the
//     effect's own text — React never ran it;
//   * an answer TOTALLY OVERRIDDEN rather than discarded (`anchorLeft: 0,
//     anchorRight: 0, anchorTop: 0, anchorBottom: 0,` after the correct
//     `...anchorOf(tab)` spread — `PopoverAnchor` is exactly those four).
//
// Each one needs a question about SHAPE — which attribute holds which handler,
// what a variable is actually initialised to, which statements a function body
// or an effect callback has AT ITS TOP LEVEL, whether the component's own body
// is where an effect sits, and what WHOLE argument a call is handed. Those are
// the six helpers below, and they are why the parser was already here.
//
// THE GENERAL RULE THEY ENCODE: pin the seam at EVERY level between the pure
// decision and the thing that runs it — the statement is in the function, the
// function is attached, the effect is in the component body. Every helper here
// is reachability-blind on its own; only its level's statement list is not.

/** Unwraps `(expr)`, however many layers of parentheses there are. */
function unwrapParens(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile(
    "guarded.tsx",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );
}

/**
 * The source text `const <name> = …` is initialised to, parentheses unwrapped.
 *
 * `objectLiteralText` above answers the same question for an object literal
 * only. This one does not care what the initializer IS, which is the point: the
 * mutation it exists to catch turned `<>{popover}{tabMenu}</>` into
 * `<>{popover}{false ? tabMenu : null}</>`, and no `toContain` on the file can
 * tell those apart — `{tabMenu}` as a substring is gone in both directions
 * depending on how the mutation is written, and the file-wide text still
 * mentions `tabMenu` either way. Bounded to the initializer, an EXACT match on
 * the whole expression is available, and every conditional fails it.
 */
export function initializerText(source: string, name: string): string {
  const file = parse(source);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined
    ) {
      found.push(unwrapParens(node.initializer).getText(file));
    }
    node.forEachChild(visit);
  };
  visit(file);
  if (found.length !== 1) {
    throw new Error(`expected exactly one \`const ${name} =\`, found ${found.length}`);
  }
  return found[0] as string;
}

/**
 * Every attribute of the ONE JSX element carrying `marker`, as a map from
 * attribute name to the source text of its value — the expression itself for
 * `attr={expr}`, the literal WITH its quotes for `attr="text"`, and the empty
 * string for a bare `attr`.
 *
 * WHY A GUARD NEEDS THIS. `onClick={() => runTabMenuItem(tabMenuRow, item.id)}`
 * was replaced with `onClick={() => undefined}` and the suite stayed green:
 * every guard in reach asserted things about `runTabMenuItem`'s BODY, and a
 * perfect handler nothing calls is a menu whose items do nothing. Asking which
 * expression a named attribute of a named element holds is the only question
 * that fails on that, and — unlike a regex over a text region — it cannot be
 * satisfied by a second element, by a comment, or by a string literal.
 *
 * Throws unless exactly one element carries `marker`, so a guard can never be
 * reading the second-best match.
 */
export function jsxAttributes(source: string, marker: string): Readonly<Record<string, string>> {
  const file = parse(source);
  const found: Record<string, string>[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const attrs: Record<string, string> = {};
      let carriesMarker = false;
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute)) continue;
        const key = attribute.name.getText(file);
        if (key === marker) carriesMarker = true;
        const value = attribute.initializer;
        if (value === undefined) attrs[key] = "";
        else if (ts.isJsxExpression(value)) {
          attrs[key] = value.expression === undefined ? "" : value.expression.getText(file);
        } else attrs[key] = value.getText(file);
      }
      if (carriesMarker) found.push(attrs);
    }
    node.forEachChild(visit);
  };
  visit(file);
  if (found.length !== 1) {
    throw new Error(`expected exactly one JSX element with ${marker}, found ${found.length}`);
  }
  return found[0] as Readonly<Record<string, string>>;
}

/**
 * The TOP-LEVEL statements of the body of the function named `name` — a
 * `function name() {}` declaration, a `const name = () => {}`, or the
 * `const name = useCallback(() => {}, deps)` this codebase is mostly made of.
 *
 * TOP-LEVEL IS THE WHOLE POINT, and it is what a text region cannot express.
 * The mutation this exists to catch replaced
 *
 *     if (tabDragBlocksContextMenu(dragRef.current)) return;
 *
 * with a dead closure CONTAINING that exact line, so a regex bounded to the
 * function still captured it and still matched. A decoy can put the text
 * anywhere; it cannot put it back in the list of statements the function
 * actually runs, in the order it runs them.
 *
 * Throws unless exactly one function of that name has a block body.
 */
export function bodyStatements(source: string, name: string): readonly string[] {
  const file = parse(source);
  const found: (readonly string[])[] = [];
  const take = (body: ts.Block): void => {
    found.push(body.statements.map((statement) => statement.getText(file)));
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body !== undefined) {
      take(node.body);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined
    ) {
      const init = unwrapParens(node.initializer);
      // `const f = () => {…}` directly, or wrapped in useCallback/useMemo —
      // the first argument is the function either way.
      const fn = ts.isCallExpression(init) ? init.arguments[0] : init;
      if (
        fn !== undefined &&
        (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
        ts.isBlock(fn.body)
      ) {
        take(fn.body);
      }
    }
    node.forEachChild(visit);
  };
  visit(file);
  if (found.length !== 1) {
    throw new Error(`expected exactly one function body named ${name}, found ${found.length}`);
  }
  return found[0] as readonly string[];
}

/**
 * The `useEffect(…)` / `useLayoutEffect(…)` call that is a DIRECT top-level
 * statement of the function `fnName`'s body and whose text contains `needle`.
 *
 * WHY "AN EFFECT CONTAINING THE NEEDLE EXISTS" IS NOT ENOUGH, walked through
 * on 2026-09-06: a file-wide search finds the call ANYWHERE, including inside a
 * function nobody invokes, so wrapping a whole effect —
 * byte-for-byte unchanged — in `const focusOnOpen = (): void => { … }; void
 * focusOnOpen;` kept an EXACT match on the effect's own text green while React
 * never ran it and focus never landed in the tab menu. Reachability is not
 * something a call site's text can carry; only its POSITION in the component's
 * own statement list can. React runs the effects a component body executes, and
 * a hook call inside a nested closure is not one of them.
 *
 * Throws unless exactly one such effect exists, so an effect that has been
 * moved, deleted or duplicated fails loudly rather than guarding nothing.
 */
export function topLevelEffectIn(source: string, fnName: string, needle: string): string {
  const file = parse(source);
  const bodies: ts.Block[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === fnName && node.body !== undefined) {
      bodies.push(node.body);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === fnName &&
      node.initializer !== undefined
    ) {
      const init = unwrapParens(node.initializer);
      const fn = ts.isCallExpression(init) ? init.arguments[0] : init;
      if (
        fn !== undefined &&
        (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
        ts.isBlock(fn.body)
      ) {
        bodies.push(fn.body);
      }
    }
    node.forEachChild(visit);
  };
  visit(file);
  if (bodies.length !== 1) {
    throw new Error(`expected exactly one function body named ${fnName}, found ${bodies.length}`);
  }
  const found: string[] = [];
  for (const statement of (bodies[0] as ts.Block).statements) {
    if (!ts.isExpressionStatement(statement)) continue;
    const call = unwrapParens(statement.expression);
    if (!ts.isCallExpression(call)) continue;
    const callee = call.expression.getText(file);
    if (callee !== "useEffect" && callee !== "useLayoutEffect") continue;
    const text = call.getText(file);
    if (text.includes(needle)) found.push(text);
  }
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one top-level effect of ${fnName} containing ${JSON.stringify(needle)}, found ${found.length}`,
    );
  }
  return found[0] as string;
}

/**
 * The TOP-LEVEL statements of an effect callback's body, given the effect's own
 * source text (from `topLevelEffectIn`).
 *
 * `bodyStatements` above answers this for a NAMED function; an effect callback
 * is anonymous, and on 2026-09-06 that gap was walked through twice. Moving
 * `document.addEventListener("pointerdown", onPointerDown)` and its keydown
 * sibling into `const register = (): void => { … }; void register;` INSIDE the
 * surviving dismissal effect left every guard green — `callsTo` is
 * reachability-blind, it returns every CallExpression the parser sees, called
 * or not — while the tab menu registered nothing and stopped closing on Escape
 * or on an outside click. The same move on `window.addEventListener("keydown",
 * onDragKeyDown)` left Escape mid-drag dead with both handler BODIES intact.
 *
 * A decoy can put a call anywhere; it cannot put it back in the list of
 * statements the effect itself runs.
 *
 * Throws unless the text is exactly one effect call with a block-bodied
 * callback.
 */
export function effectStatements(effect: string): readonly string[] {
  const file = parse(effect);
  const found: (readonly string[])[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(file);
      if (callee === "useEffect" || callee === "useLayoutEffect") {
        const fn = node.arguments[0];
        if (
          fn !== undefined &&
          (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
          ts.isBlock(fn.body)
        ) {
          found.push(fn.body.statements.map((statement) => statement.getText(file)));
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(file);
  if (found.length !== 1) {
    throw new Error(`expected exactly one block-bodied effect, found ${found.length}`);
  }
  return found[0] as readonly string[];
}

// ---------------------------------------------------------------------------
// WHAT AN EXPRESSION *IS*, not merely what it mentions. Added 2026-09-07 after
// a validator walked five more mutations of the launch-or-attach affordance
// past a green suite (49 files / 1183 tests, tsc 0), every one of them invisible
// to the helpers above:
//
//   * a ternary's false arm wrapped in an UN-INVOKED IIFE
//     (`((): ReactNode => { const built = createPortal(…); void built; return
//     null; })()`) — `initializerText(...).toContain("createPortal(")` stayed
//     true while `picker` was permanently null and the thread picker never
//     rendered at all;
//   * a JSX handler's whole body moved into a decoy closure
//     (`onClick={() => { const act = () => { …real work… }; void act; }}`) —
//     defeats `toContain` on the attribute, because the attribute still
//     contains every asserted substring;
//   * the SAME decoy inside a `useCallback` whose single statement is an rpc
//     call — `bodyStatements` still reports length 1, and the one statement
//     still contains the call's text, because the text is in the dead closure;
//   * a concise-bodied `useCallback` turned into a block that computes the real
//     answer into a dead local and returns `Promise.resolve([])` instead.
//
// The common shape: the guarded TEXT survives, moved one level down into
// something nothing runs. The question that fails on all four is structural —
// which arm of a ternary, which statements a handler runs, what an arrow
// actually EVALUATES TO, and which call a chain is rooted at.

/** The three parts of a `const <name> = cond ? a : b` initializer. */
export interface TernaryArms {
  readonly condition: string;
  readonly whenTrue: string;
  readonly whenFalse: string;
}

/**
 * The parsed arms of the conditional expression `const <name>` is initialised
 * to.
 *
 * WHY NOT `initializerText(...).toContain(…)`: the arms are where the meaning
 * is. `state !== "picker" ? null : createPortal(…)` and
 * `state !== "picker" ? null : ((): ReactNode => { createPortal(…); return
 * null; })()` contain exactly the same substrings, and only one of them
 * renders anything. Split into arms, a guard can say the false arm IS the
 * portal call rather than merely mentioning one.
 *
 * Throws unless exactly one `const <name>` is initialised to a ternary, so a
 * guard can never be reading a different declaration or a reshaped one.
 */
export function ternaryArms(source: string, name: string): TernaryArms {
  const file = parse(source);
  const found: TernaryArms[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined
    ) {
      const init = unwrapParens(node.initializer);
      if (ts.isConditionalExpression(init)) {
        found.push({
          condition: init.condition.getText(file),
          whenTrue: init.whenTrue.getText(file),
          whenFalse: init.whenFalse.getText(file),
        });
      }
    }
    node.forEachChild(visit);
  };
  visit(file);
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one \`const ${name} = … ? … : …\`, found ${found.length}`,
    );
  }
  return found[0] as TernaryArms;
}

/**
 * The OUTERMOST arrow function or function expression in `text` — the one a
 * JSX attribute or a `useCallback` argument actually hands over.
 *
 * Nested functions are deliberately NOT visited: a decoy hides the real work in
 * one, and a helper that descended into it would find the decoy's body and
 * report it as the handler's.
 *
 * Throws unless there is exactly one.
 */
function outermostFunction(text: string): { file: ts.SourceFile; fn: ts.ArrowFunction | ts.FunctionExpression } {
  const file = parse(text);
  const found: (ts.ArrowFunction | ts.FunctionExpression)[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      found.push(node);
      return; // do NOT descend — a nested function is not this one.
    }
    node.forEachChild(visit);
  };
  visit(file);
  if (found.length !== 1) {
    throw new Error(`expected exactly one outermost function in the guarded expression, found ${found.length}`);
  }
  return { file, fn: found[0] as ts.ArrowFunction | ts.FunctionExpression };
}

/**
 * The TOP-LEVEL statements of a JSX handler — `onClick={() => { … }}`, given
 * that attribute's value text from `jsxAttributes`.
 *
 * `bodyStatements` asks this of a NAMED function and `effectStatements` of an
 * effect callback; a handler attribute is neither, and that gap is what the
 * decoy walked through on 2026-09-07: `onClick={() => { const act = (): void =>
 * { dispatch(…); onRun(…); }; void act; }}` satisfies every `toContain` the
 * attribute guard made, and clicking the item does nothing whatsoever.
 *
 * A decoy can put the text anywhere. It cannot put it back in the list of
 * statements the handler runs, in the order it runs them.
 *
 * Throws unless the text is exactly one block-bodied function.
 */
export function handlerStatements(text: string): readonly string[] {
  const { file, fn } = outermostFunction(text);
  if (!ts.isBlock(fn.body)) {
    throw new Error("the guarded handler has no block body to list statements of");
  }
  return fn.body.statements.map((statement) => statement.getText(file));
}

/**
 * The expression the outermost arrow in `text` EVALUATES TO: its concise body,
 * or the argument of the `return` its block body ends with.
 *
 * WHY THE RESULT AND NOT THE TEXT. `useCallback(() => rpcRef.current.call(…)…)`
 * was mutated into a block that computes the real chain into a dead local and
 * returns `Promise.resolve([])`; the initializer still contained every asserted
 * substring, and the picker silently showed "No threads in this project yet."
 * forever. Asking what comes BACK is the only question that fails on that.
 *
 * Both shapes are accepted because both are honest ways to write the same
 * function; what is refused is a block that ends in anything other than a
 * return, because then the arrow's answer is `undefined` and there is nothing
 * for a guard to pin.
 */
export function arrowResult(text: string): string {
  const { file, fn } = outermostFunction(text);
  if (!ts.isBlock(fn.body)) return unwrapParens(fn.body).getText(file);
  const last = fn.body.statements[fn.body.statements.length - 1];
  if (last === undefined || !ts.isReturnStatement(last) || last.expression === undefined) {
    throw new Error("the guarded function's body does not end in `return <expression>;`");
  }
  return unwrapParens(last.expression).getText(file);
}

/**
 * The callee at the ROOT of a call chain — `rpcRef.current.call` for
 * `rpcRef.current.call(a, b).then(f).catch(g)` — with all whitespace removed,
 * because a chain broken across lines by the formatter would otherwise put a
 * newline and an indent in the middle of the answer.
 *
 * WHAT IT REFUSES is the point: an expression that is not a call at all throws.
 * `void ((): void => { rpcRef.current.call(…)…; });` keeps the enclosing
 * function's statement list at length one and keeps every substring of the real
 * call inside it, and the rpc is never issued. Asking what the statement's own
 * expression IS fails on that immediately.
 *
 * Removing whitespace is safe here and nowhere else: a callee is a chain of
 * identifiers and dots, never a string or a literal.
 */
export function rootCallee(text: string): string {
  const file = parse(text);
  const statements = file.statements;
  if (statements.length !== 1 || !ts.isExpressionStatement(statements[0] as ts.Statement)) {
    throw new Error("expected the guarded text to be exactly one expression");
  }
  const root = unwrapParens((statements[0] as ts.ExpressionStatement).expression);
  if (!ts.isCallExpression(root)) {
    throw new Error(`expected a call expression, found \`${root.getText(file).split("\n")[0] ?? ""}\``);
  }
  let current: ts.CallExpression = root;
  for (;;) {
    const callee = unwrapParens(current.expression);
    const receiver =
      ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
        ? unwrapParens(callee.expression)
        : undefined;
    if (receiver !== undefined && ts.isCallExpression(receiver)) {
      current = receiver;
      continue;
    }
    return callee.getText(file).replace(/\s+/g, "");
  }
}
