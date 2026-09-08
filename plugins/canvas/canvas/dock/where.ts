// Where in bb a person is — path in, meaning out; meaning in, sentence out.
//
// The strip publishes its own `location.pathname` on every roster poll and
// learns everyone else's back (canvas/locations.ts holds the server half). What
// a path MEANS, what to call it, and whether it is safe to put in an href are
// three decisions, and this project has no jsdom — so they live here as pure
// string functions rather than inline in canvas/dock/dock.ts, which is the same
// rule anchor.ts, expand.ts and model.ts follow.
//
// TRUST: `path` and `title` reach a viewer's browser having been asserted by
// ANOTHER client (the same spike-level trust boundary canvas/identity.ts
// documents for names — the server cannot see the Cloudflare Access header on
// an rpc call, so it takes a client's word for its own name and, now, its own
// whereabouts). Everything here therefore treats both as hostile input:
// `jumpHref` refuses anything that is not a rooted same-origin path, and every
// label is written into `textContent`, never into markup.

/** Longest path this plugin will put in an href. A bb route is tens of
 * characters; a kilobyte of "path" is somebody probing, not somebody browsing. */
export const MAX_PATH_LENGTH = 512;

/** One place in bb, as the strip understands it. */
export type BbLocation =
  | {
      readonly kind: "thread";
      /** The path to navigate to — sub-route and all. */
      readonly path: string;
      readonly projectId: string;
      readonly threadId: string;
    }
  | {
      readonly kind: "panel";
      readonly path: string;
      readonly plugin: string;
      readonly panel: string;
      /**
       * Everything after `/plugins/<plugin>/<panel>`, which is bb's own
       * deep-link slot: the SDK renders a nav panel for
       * `/plugins/<pluginId>/<path>/*` and hands the panel the remainder as
       * `subPath` (@get-bb/plugin-sdk bundled types, bb-plugin-sdk-app.d.ts:344-355).
       * For this plugin that remainder is which canvas PAGE somebody is on.
       *
       * ABSENT means absent: on a bare panel route the key is not set at all,
       * rather than "" or null. One spelling of "no page was asked for" is
       * enough, and `undefined` is the one TypeScript already makes callers
       * handle.
       *
       * It is a verbatim slice of the cleaned `path`, NOT a path in its own
       * right, and it is as untrusted as everything else here (see the TRUST
       * note above) — never hand it to `jumpHref`; the href always comes from
       * `.path`.
       */
      readonly subPath?: string;
    }
  | { readonly kind: "settings"; readonly path: string }
  | { readonly kind: "home"; readonly path: string }
  | { readonly kind: "other"; readonly path: string };

/**
 * Read a bb pathname.
 *
 * Query and hash are dropped first: the strip feeds this its own
 * `location.pathname` (which has neither) AND paths that arrived over the wire
 * from another tab (which might). A trailing slash is normalised away for the
 * same reason — `/settings` and `/settings/` are one place, and an empty last
 * segment would otherwise turn a thread route into an unrecognised one.
 *
 * Anything not rooted at "/" is `other` rather than home: "" is what a member
 * with no reported location degrades to, and reading that as "on the home
 * screen" would be a confident lie.
 */
export function parseLocation(path: string): BbLocation {
  const clean = normalisePath(path);
  if (clean === null) return { kind: "other", path };
  if (clean === "/") return { kind: "home", path: clean };

  const segments = clean.slice(1).split("/");
  const [first, second, third] = segments;

  if (first === "settings") return { kind: "settings", path: clean };

  if (
    first === "projects" &&
    second !== undefined &&
    second.length > 0 &&
    third === "threads" &&
    segments[3] !== undefined &&
    segments[3].length > 0
  ) {
    return {
      kind: "thread",
      path: clean,
      projectId: second,
      threadId: segments[3],
    };
  }

  if (
    first === "plugins" &&
    second !== undefined &&
    second.length > 0 &&
    third !== undefined &&
    third.length > 0
  ) {
    // The remainder is cut from `clean`, so it inherits this function's whole
    // normalisation (query/hash dropped, trailing slash trimmed) and can never
    // disagree with `.path` — which is what keeps the label and the jump link
    // describing the same place. No further cleaning is applied: widening or
    // rewriting it here would make it look safer than it is.
    const rest = segments.slice(3).join("/");
    return rest.length > 0
      ? { kind: "panel", path: clean, plugin: second, panel: third, subPath: rest }
      : { kind: "panel", path: clean, plugin: second, panel: third };
  }

  return { kind: "other", path: clean };
}

/**
 * What to call somebody's whereabouts, in the second half of a sentence like
 * "alice — in this thread".
 *
 * `there` is null when the location is unknown OR STALE (the server nulls it
 * past LOCATION_STALE_MS; see canvas/locations.ts). That case gets its own
 * honest sentence rather than the last thing we happened to know, because a
 * stale location is worse than none — it sends people to the wrong page.
 *
 * `here` is the VIEWER's own location, which is what turns "in thread thr_x"
 * into "in this thread". `title` is what the other tab reported (it reads its
 * own `document.title`, so no lookup is needed on this side): the thread title
 * for a thread, and the canvas PAGE NAME for a canvas panel, which is the only
 * way that name can get here at all — the path carries a page ID, not a name.
 * It is ignored for every other location.
 */
export function locationLabel(
  there: BbLocation | null,
  here: BbLocation | null,
  title?: string | null,
): string {
  if (there === null) return "somewhere in bb";
  switch (there.kind) {
    case "thread":
      if (here !== null && here.kind === "thread" && here.threadId === there.threadId) {
        return "in this thread";
      }
      return title !== undefined && title !== null && title.trim().length > 0
        ? `in “${title.trim()}”`
        : `in thread ${there.threadId}`;
    case "panel": {
      // The canvas is the one panel this plugin may name from the inside.
      if (there.plugin !== "canvas" || there.panel !== "canvas") {
        return `in the ${there.plugin} plugin`;
      }
      // Naming the PAGE needs both halves and settles for neither: the subPath
      // says a specific page was addressed, the title says what it is called.
      // With only one of them, the honest answer is still the old flat one —
      // a page name invented for a client that reported no page would be the
      // same confident lie a stale location is.
      const pageName = title === undefined || title === null ? "" : title.trim();
      return there.subPath !== undefined && pageName.length > 0
        ? `on the canvas — “${pageName}”`
        : "on the canvas";
    }
    case "settings":
      return "in settings";
    case "home":
      return "on the home screen";
    case "other":
      return `on ${there.path}`;
  }
}

/**
 * The value safe to put in `<a href>`, or null for "do not offer the link".
 *
 * A ROOTED SAME-ORIGIN PATH AND NOTHING ELSE. "//evil.example/x" is the one
 * that matters: it looks like a path, it passes a naive `startsWith("/")`, and
 * it is a cross-origin navigation. `javascript:` and absolute URLs are refused
 * for the obvious reason, whitespace and control characters because a path
 * carrying them is not a bb route, and anything past MAX_PATH_LENGTH because a
 * link nobody can read is not a link.
 */
export function jumpHref(path: string | null | undefined): string | null {
  if (typeof path !== "string") return null;
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) return null;
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(path)) return null;
  return path;
}

/** Drop query/hash and any trailing slash. Null when the result is not a rooted
 * path at all, which is the caller's cue to keep the raw string. */
function normalisePath(path: string): string | null {
  const cut = path.split(/[?#]/, 1)[0] ?? "";
  if (!cut.startsWith("/")) return null;
  if (cut.length === 1) return "/";
  return cut.endsWith("/") ? cut.slice(0, -1) : cut;
}
