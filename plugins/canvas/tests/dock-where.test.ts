// Run: npx vitest run tests/dock-where.test.ts
//
// "Where in bb is that person" — the string half, and therefore the whole
// decision. The strip renders a label and an <a href> from these answers, so a
// mistake here is a link that lands somewhere else; there is no jsdom in this
// project, so if the parsing lived inline in dock.ts it would live where no
// test can reach it (the same rule anchor.ts / expand.ts / model.ts follow).
import { describe, expect, it } from "vitest";
import {
  jumpHref,
  locationLabel,
  parseLocation,
  type BbLocation,
} from "../canvas/dock/where.js";

const THREAD = "/projects/proj_8hg8rx3pkb/threads/thr_yqimg5fy84";

describe("parseLocation", () => {
  it("reads a thread route as its project and thread", () => {
    expect(parseLocation(THREAD)).toEqual({
      kind: "thread",
      path: THREAD,
      projectId: "proj_8hg8rx3pkb",
      threadId: "thr_yqimg5fy84",
    });
  });

  it("still reads a thread sub-route as that thread", () => {
    // bb hangs sub-routes off a thread; you are still in the thread, and the
    // href must keep the sub-route so the jump lands where they actually are.
    const path = `${THREAD}/files`;
    expect(parseLocation(path)).toEqual({
      kind: "thread",
      path,
      projectId: "proj_8hg8rx3pkb",
      threadId: "thr_yqimg5fy84",
    });
  });

  it("reads a plugin panel route as its plugin and panel", () => {
    expect(parseLocation("/plugins/canvas/canvas")).toEqual({
      kind: "panel",
      path: "/plugins/canvas/canvas",
      plugin: "canvas",
      panel: "canvas",
    });
  });

  it("leaves subPath OFF a bare panel route rather than reporting an empty one", () => {
    // Absent is spelled ABSENT (the key is not present at all), not "" and not
    // null: "" would read as "a subPath that happens to be empty", and every
    // consumer would then have to know that "" means "no page was asked for".
    const there = parseLocation("/plugins/canvas/canvas");
    expect(Object.hasOwn(there, "subPath")).toBe(false);
    expect((there as { subPath?: string }).subPath).toBeUndefined();
  });

  it("reads the segments after the panel as its subPath", () => {
    // bb renders /plugins/<pluginId>/<path>/* and hands the panel the
    // remainder as `subPath` (@get-bb/plugin-sdk bundled types,
    // bb-plugin-sdk-app.d.ts:344-355). That remainder is how one canvas PAGE
    // is addressable, so the strip has to be able to see it in a reported path.
    expect(parseLocation("/plugins/canvas/canvas/page:retro")).toEqual({
      kind: "panel",
      path: "/plugins/canvas/canvas/page:retro",
      plugin: "canvas",
      panel: "canvas",
      subPath: "page:retro",
    });
  });

  it("keeps a multi-segment subPath whole", () => {
    expect(parseLocation("/plugins/notes/notes/work/ideas.md")).toMatchObject({
      kind: "panel",
      plugin: "notes",
      panel: "notes",
      subPath: "work/ideas.md",
    });
  });

  it("normalises the subPath the same way it normalises the path", () => {
    // The subPath is cut from the ALREADY-cleaned path, so it inherits the
    // query/hash drop and the trailing-slash trim for free — it can never
    // disagree with `.path`, which is the property that keeps the label and
    // the jump link talking about the same place.
    expect(parseLocation("/plugins/canvas/canvas/page:retro/")).toMatchObject({
      path: "/plugins/canvas/canvas/page:retro",
      subPath: "page:retro",
    });
    expect(
      parseLocation("/plugins/canvas/canvas/page:retro?zoom=2#top"),
    ).toMatchObject({
      path: "/plugins/canvas/canvas/page:retro",
      subPath: "page:retro",
    });
  });

  it("reads settings, and anything under it, as settings", () => {
    expect(parseLocation("/settings").kind).toBe("settings");
    expect(parseLocation("/settings/plugins").kind).toBe("settings");
  });

  it("reads the root as home", () => {
    expect(parseLocation("/")).toEqual({ kind: "home", path: "/" });
  });

  it("keeps anything it does not recognise as itself", () => {
    expect(parseLocation("/projects/proj_8hg8rx3pkb")).toEqual({
      kind: "other",
      path: "/projects/proj_8hg8rx3pkb",
    });
  });

  it("drops a query string and a hash before deciding", () => {
    // The strip reads location.pathname, but the same parser is fed paths that
    // came off the wire from another tab, and those it did not construct.
    expect(parseLocation(`${THREAD}?tab=diff#top`)).toMatchObject({
      kind: "thread",
      path: THREAD,
      threadId: "thr_yqimg5fy84",
    });
  });

  it("normalises a trailing slash rather than inventing an empty segment", () => {
    expect(parseLocation("/settings/").kind).toBe("settings");
    expect(parseLocation(`${THREAD}/`)).toMatchObject({
      kind: "thread",
      path: THREAD,
    });
  });

  it("treats an empty or relative path as other, never as home", () => {
    // "" is what a member with no reported location would degrade to if the
    // caller forgot to check; it must not read as "on the home screen".
    expect(parseLocation("")).toEqual({ kind: "other", path: "" });
    expect(parseLocation("projects/p/threads/t").kind).toBe("other");
  });
});

describe("locationLabel", () => {
  const here = parseLocation(THREAD);

  it("says so plainly when the location is unknown", () => {
    // A stale location is worse than none: this is the sentence a member who
    // has gone quiet gets, and it is deliberately not a guess.
    expect(locationLabel(null, here)).toBe("somewhere in bb");
  });

  it("says 'in this thread' when they are where the viewer is", () => {
    expect(locationLabel(parseLocation(THREAD), here)).toBe("in this thread");
  });

  it("names the thread by title when it is a different one", () => {
    const there = parseLocation(
      "/projects/proj_8hg8rx3pkb/threads/thr_cjnyuqz388",
    );
    expect(locationLabel(there, here, "glossary measure")).toBe(
      "in “glossary measure”",
    );
  });

  it("falls back to the thread id when no title travelled with it", () => {
    const there = parseLocation(
      "/projects/proj_8hg8rx3pkb/threads/thr_cjnyuqz388",
    );
    expect(locationLabel(there, here)).toBe("in thread thr_cjnyuqz388");
  });

  it("calls the canvas page the canvas", () => {
    expect(locationLabel(parseLocation("/plugins/canvas/canvas"), here)).toBe(
      "on the canvas",
    );
  });

  it("names the canvas PAGE when the path carries one and a title travelled with it", () => {
    // The page NAME is not in the path (the path carries an id), so it arrives
    // exactly the way a thread title does: the other tab reads its own
    // document.title and reports it, and no lookup happens on this side.
    expect(
      locationLabel(
        parseLocation("/plugins/canvas/canvas/page:retro"),
        here,
        "Retro",
      ),
    ).toBe("on the canvas — “Retro”");
  });

  it("trims a canvas page title, and ignores one that is only whitespace", () => {
    // Same trim/empty handling as the thread case, for the same reason: a
    // title of "   " is a title nobody wrote.
    const there = parseLocation("/plugins/canvas/canvas/page:retro");
    expect(locationLabel(there, here, "  Retro  ")).toBe(
      "on the canvas — “Retro”",
    );
    expect(locationLabel(there, here, "   ")).toBe("on the canvas");
    expect(locationLabel(there, here, "")).toBe("on the canvas");
    expect(locationLabel(there, here, null)).toBe("on the canvas");
  });

  it("still says a flat 'on the canvas' when no page rode along", () => {
    // The pre-multi-page answer has to survive untouched: a client that has
    // not been taught to put its page in the path reports the bare panel
    // route, and inventing a page name for it would be the confident lie
    // this module exists to refuse.
    expect(
      locationLabel(parseLocation("/plugins/canvas/canvas"), here, "Retro"),
    ).toBe("on the canvas");
    expect(
      locationLabel(parseLocation("/plugins/canvas/canvas/page:retro"), here),
    ).toBe("on the canvas");
  });

  it("names another plugin's panel by its plugin", () => {
    expect(locationLabel(parseLocation("/plugins/tasks/board"), here)).toBe(
      "in the tasks plugin",
    );
  });

  it("labels settings, home and anything else", () => {
    expect(locationLabel(parseLocation("/settings"), here)).toBe("in settings");
    expect(locationLabel(parseLocation("/"), here)).toBe("on the home screen");
    expect(locationLabel(parseLocation("/whatever"), here)).toBe(
      "on /whatever",
    );
  });

  it("works with no viewer location at all", () => {
    // The strip runs on routes it does not recognise, and on the very first
    // frame before it has read its own pathname.
    expect(locationLabel(parseLocation(THREAD), null)).toBe(
      "in thread thr_yqimg5fy84",
    );
  });

  it("ignores a title for a location that is not a thread or the canvas", () => {
    expect(
      locationLabel(parseLocation("/settings"), here, "not a thread"),
    ).toBe("in settings");
    // Another plugin's panel has a subPath too; this plugin still may not
    // claim to know what it means.
    expect(
      locationLabel(parseLocation("/plugins/tasks/board/RLY-12"), here, "Bug"),
    ).toBe("in the tasks plugin");
  });
});

describe("a subPath is hostile input, like everything else off the wire", () => {
  // `path` arrives asserted by ANOTHER client (see this module's TRUST note),
  // so a subPath is just a longer stretch of the same untrusted string. It is
  // cut from the cleaned path and never becomes an href on its own: the strip
  // links `.path`, which jumpHref judges exactly as it did before.
  const here = parseLocation("/plugins/canvas/canvas");

  it("refuses a protocol-relative payload smuggled in as a subPath", () => {
    const path = "/plugins/canvas/canvas///evil.example/x";
    const there = parseLocation(path);
    expect(there).toMatchObject({ kind: "panel", subPath: "//evil.example/x" });
    // The href on offer is the rooted same-origin path, unchanged...
    expect(jumpHref(there.path)).toBe(path);
    // ...and the subPath itself, were anyone ever to hand it to jumpHref,
    // is refused for the very reason it was crafted.
    expect(jumpHref((there as { subPath?: string }).subPath)).toBeNull();
  });

  it("refuses an absolute-URL subPath through the same door", () => {
    const there = parseLocation("/plugins/canvas/canvas/https://evil.example");
    expect(jumpHref((there as { subPath?: string }).subPath)).toBeNull();
  });

  it("keeps a javascript: payload inert — it is text, never a scheme", () => {
    const path = "/plugins/canvas/canvas/javascript:alert(1)";
    const there = parseLocation(path);
    expect((there as { subPath?: string }).subPath).toBe("javascript:alert(1)");
    // As a subPath it is refused outright...
    expect(jumpHref((there as { subPath?: string }).subPath)).toBeNull();
    // ...and as part of the whole path it is a same-origin route with a silly
    // name, which is what a rooted path starting with "/" always is.
    expect(jumpHref(path)).toBe(path);
    expect(jumpHref(path)!.startsWith("/plugins/")).toBe(true);
  });

  it("refuses a kilobyte of subPath rather than putting it in the DOM", () => {
    const path = `/plugins/canvas/canvas/${"a".repeat(1_000)}`;
    const there = parseLocation(path);
    expect((there as { subPath?: string }).subPath).toHaveLength(1_000);
    expect(jumpHref(there.path)).toBeNull();
  });

  it("hands back a hostile title as inert text, never as markup", () => {
    // Every label this module produces goes into textContent, so the one
    // guarantee that matters is that it stays a plain string: nothing is
    // escaped, stripped or interpreted here, and nothing needs to be.
    const there = parseLocation("/plugins/canvas/canvas/page:x");
    const label = locationLabel(there, here, "<img src=x onerror=alert(1)>");
    expect(label).toBe("on the canvas — “<img src=x onerror=alert(1)>”");
    expect(typeof label).toBe("string");
  });
});

describe("jumpHref", () => {
  it("hands back a same-origin absolute path unchanged", () => {
    expect(jumpHref(THREAD)).toBe(THREAD);
  });

  it("refuses a protocol-relative path", () => {
    // "//evil.example" in an href is a cross-origin navigation wearing a
    // path's clothes, and this value came off the wire from another client.
    expect(jumpHref("//evil.example/steal")).toBeNull();
  });

  it("refuses anything that is not a rooted path", () => {
    expect(jumpHref("javascript:alert(1)")).toBeNull();
    expect(jumpHref("https://evil.example")).toBeNull();
    expect(jumpHref("settings")).toBeNull();
    expect(jumpHref("")).toBeNull();
  });

  it("refuses null and undefined, which is what an unknown location is", () => {
    expect(jumpHref(null)).toBeNull();
    expect(jumpHref(undefined)).toBeNull();
  });

  it("refuses a path carrying whitespace or control characters", () => {
    expect(jumpHref("/threads/ evil")).toBeNull();
    expect(jumpHref("/threads/\nevil")).toBeNull();
  });

  it("refuses an absurdly long path rather than putting it in the DOM", () => {
    expect(jumpHref(`/${"a".repeat(1_000)}`)).toBeNull();
  });
});

describe("the location type is a closed set", () => {
  it("covers every kind the strip can be handed", () => {
    // A compile-time exhaustiveness check that also runs: adding a kind
    // without teaching locationLabel about it fails here first.
    const kinds: Array<BbLocation["kind"]> = [
      "thread",
      "panel",
      "settings",
      "home",
      "other",
    ];
    for (const path of [
      THREAD,
      "/plugins/canvas/canvas",
      "/settings",
      "/",
      "/nope",
    ]) {
      expect(kinds).toContain(parseLocation(path).kind);
    }
  });
});
