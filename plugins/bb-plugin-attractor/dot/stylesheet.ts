/**
 * `model_stylesheet` parser + resolver.
 *
 * Grammar: `selector { prop: value; ... }` repeated, with selectors `*`,
 * a shape name, `.class`, `#id`. Specificity: 0 (`*`) / 1 (shape) / 2 (`.class`)
 * / 3 (`#id`); last rule wins ties. Only `model`, `provider` and
 * `reasoning_effort` properties are recognised.
 *
 * Pure module: no BB imports, no I/O.
 */

export type SelectorType = "*" | "shape" | "class" | "id";

export interface StyleProps {
  model?: string;
  provider?: string;
  reasoningEffort?: "low" | "medium" | "high";
}

export interface StyleRule {
  selectorType: SelectorType;
  selectorValue?: string;
  specificity: 0 | 1 | 2 | 3;
  props: StyleProps;
  order: number;
}

export interface StyleTarget {
  id: string;
  shape: string;
  classes: string[];
}

class StylesheetSyntaxError extends Error {}

const PROP_ALIASES: Record<string, keyof StyleProps> = {
  model: "model",
  provider: "provider",
  reasoning_effort: "reasoningEffort",
};

export function parseStylesheet(source: string): StyleRule[] {
  const text = source.trim();
  if (text === "") return [];

  const rules: StyleRule[] = [];
  let i = 0;
  const n = text.length;
  let order = 0;

  const skipWs = () => {
    while (i < n && /\s/.test(text[i])) i++;
  };

  while (true) {
    skipWs();
    if (i >= n) break;

    // selector
    const selectorStart = i;
    while (i < n && text[i] !== "{") i++;
    if (i >= n) {
      throw new StylesheetSyntaxError(`expected '{' after selector '${text.slice(selectorStart).trim()}'`);
    }
    const selectorText = text.slice(selectorStart, i).trim();
    if (selectorText === "") {
      throw new StylesheetSyntaxError(`empty selector before position ${i}`);
    }

    let selectorType: SelectorType;
    let selectorValue: string | undefined;
    let specificity: 0 | 1 | 2 | 3;
    if (selectorText === "*") {
      selectorType = "*";
      specificity = 0;
    } else if (selectorText.startsWith("#")) {
      selectorType = "id";
      selectorValue = selectorText.slice(1);
      specificity = 3;
    } else if (selectorText.startsWith(".")) {
      selectorType = "class";
      selectorValue = selectorText.slice(1);
      specificity = 2;
    } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(selectorText)) {
      selectorType = "shape";
      selectorValue = selectorText;
      specificity = 1;
    } else {
      throw new StylesheetSyntaxError(`invalid selector '${selectorText}'`);
    }

    i++; // consume '{'
    const bodyStart = i;
    let depth = 1;
    while (i < n && depth > 0) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      if (depth > 0) i++;
    }
    if (depth !== 0) {
      throw new StylesheetSyntaxError(`unterminated rule body for selector '${selectorText}'`);
    }
    const body = text.slice(bodyStart, i);
    i++; // consume '}'

    const props: StyleProps = {};
    const declarations = body
      .split(";")
      .map((d) => d.trim())
      .filter((d) => d.length > 0);
    for (const decl of declarations) {
      const colonIdx = decl.indexOf(":");
      if (colonIdx === -1) {
        throw new StylesheetSyntaxError(`malformed declaration '${decl}' (expected 'prop: value')`);
      }
      const propName = decl.slice(0, colonIdx).trim();
      const propValue = decl.slice(colonIdx + 1).trim();
      const key = PROP_ALIASES[propName];
      if (!key) {
        throw new StylesheetSyntaxError(`unknown stylesheet property '${propName}'`);
      }
      if (key === "reasoningEffort") {
        if (propValue !== "low" && propValue !== "medium" && propValue !== "high") {
          throw new StylesheetSyntaxError(`invalid reasoning_effort value '${propValue}'`);
        }
        props.reasoningEffort = propValue;
      } else {
        props[key] = propValue;
      }
    }

    rules.push({ selectorType, selectorValue, specificity, props, order: order++ });
  }

  return rules;
}

function matches(rule: StyleRule, target: StyleTarget): boolean {
  switch (rule.selectorType) {
    case "*":
      return true;
    case "shape":
      return rule.selectorValue === target.shape;
    case "class":
      return rule.selectorValue !== undefined && target.classes.includes(rule.selectorValue);
    case "id":
      return rule.selectorValue === target.id;
    default:
      return false;
  }
}

export function resolveStyle(
  target: StyleTarget,
  rules: StyleRule[],
  explicit?: Partial<StyleProps>,
): StyleProps {
  const matching = rules
    .filter((r) => matches(r, target))
    .sort((a, b) => (a.specificity - b.specificity) || (a.order - b.order));

  const resolved: StyleProps = {};
  for (const rule of matching) {
    Object.assign(resolved, rule.props);
  }
  if (explicit) {
    for (const [key, value] of Object.entries(explicit)) {
      if (value !== undefined) {
        (resolved as Record<string, unknown>)[key] = value;
      }
    }
  }
  return resolved;
}
