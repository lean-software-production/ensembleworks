/**
 * A key-value run context addressed by dot-path (matching dot/conditions.ts's
 * `context.<path>` key resolution), with deep-copy semantics so parallel
 * branches can mutate an isolated copy without affecting the parent.
 *
 * Pure module: no BB imports, no I/O, no randomness.
 */

import type { JsonValue } from "../dot/graph";
import type { Context } from "./types";

function deepClone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function getPath(root: Record<string, JsonValue>, path: string): JsonValue | undefined {
  const segments = path.split(".").filter((s) => s.length > 0);
  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    // Only resolve own keys: a plain index lookup would also resolve inherited
    // Object.prototype members (constructor, toString, ...).
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current as JsonValue | undefined;
}

function setPath(root: Record<string, JsonValue>, path: string, value: JsonValue): void {
  const segments = path.split(".").filter((s) => s.length > 0);
  if (segments.length === 0) return;
  let current: Record<string, JsonValue> = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    const next = current[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, JsonValue>;
  }
  current[segments[segments.length - 1]] = value;
}

class ContextImpl implements Context {
  private root: Record<string, JsonValue>;

  constructor(initial: Record<string, JsonValue> = {}) {
    this.root = deepClone(initial);
  }

  get(path: string): JsonValue | undefined {
    return getPath(this.root, path);
  }

  set(path: string, value: JsonValue): void {
    setPath(this.root, path, deepClone(value));
  }

  merge(updates: Record<string, JsonValue> | undefined): void {
    if (!updates) return;
    for (const [key, value] of Object.entries(updates)) {
      this.root[key] = deepClone(value);
    }
  }

  toObject(): Record<string, JsonValue> {
    return deepClone(this.root);
  }

  clone(): Context {
    return new ContextImpl(this.root);
  }
}

export function createContext(initial?: Record<string, JsonValue>): Context {
  return new ContextImpl(initial);
}
