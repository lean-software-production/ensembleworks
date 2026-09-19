import { z } from "zod";
import { normalizeEmail } from "./request-context.js";

/**
 * The people directory: who is who on this bb server, keyed by the emails Cloudflare
 * Access reports. Stored as the "directory" plugin setting (a JSON array).
 */
const personSchema = z.object({
  person: z.string().regex(/^[a-z_][a-z0-9_-]*$/, "person must match ^[a-z_][a-z0-9_-]*$"),
  github: z.string().min(1),
  displayName: z.string().min(1),
  emails: z.array(z.email()).min(1),
}).strict();

export type Person = z.infer<typeof personSchema>;

export type DirectoryParse = { ok: true; people: Person[] } | { ok: false; error: string };

export function parseDirectory(text: string): DirectoryParse {
  if (text.trim().length === 0) return { ok: true, people: [] };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `directory is not valid JSON: ${(error as Error).message}` };
  }
  const parsed = z.array(personSchema).safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` at [${issue.path.join(".")}]` : "";
    return { ok: false, error: `directory is invalid${where}: ${issue?.message ?? "unknown error"}` };
  }
  const people = new Set<string>();
  const emails = new Map<string, string>();
  for (const entry of parsed.data) {
    if (people.has(entry.person)) return { ok: false, error: `directory lists person "${entry.person}" twice` };
    people.add(entry.person);
    for (const email of entry.emails) {
      const key = email.toLowerCase();
      const owner = emails.get(key);
      if (owner !== undefined) {
        return { ok: false, error: `directory email "${key}" belongs to both "${owner}" and "${entry.person}"` };
      }
      emails.set(key, entry.person);
    }
  }
  return { ok: true, people: parsed.data };
}

export function resolvePerson(people: readonly Person[], email: string | null | undefined): Person | null {
  const wanted = normalizeEmail(email);
  if (wanted === null) return null;
  return people.find((entry) => entry.emails.some((candidate) => candidate.toLowerCase() === wanted)) ?? null;
}

/**
 * The identity of a requester. `fallbackEmail` stands in when the request carries no
 * Access header (a bb server not behind Cloudflare Access, e.g. a laptop); note that on
 * such a server every header-less caller, agents and CLI included, is attributed to it.
 */
export function identityFor(
  people: readonly Person[],
  email: string | null | undefined,
  fallbackEmail: string | null | undefined,
): { email: string | null; person: Person | null; viaFallback: boolean } {
  const own = normalizeEmail(email);
  const effective = own ?? normalizeEmail(fallbackEmail);
  return {
    email: effective,
    person: resolvePerson(people, effective),
    // True when the request carried no identity of its own and the setting supplied one.
    // The guardrail must not act on that: it is a display default, not a person asking.
    viaFallback: own === null && effective !== null,
  };
}
