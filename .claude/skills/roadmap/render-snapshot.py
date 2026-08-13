#!/usr/bin/env python3
"""Render a canvas roadmap document to a published Markdown snapshot.

Read-only: consumes the JSON from `canvas roadmap read <name>` and emits
Markdown on stdout. It never writes to the canvas. The output is explicitly
labelled as a snapshot, not the source of truth (see PUBLISH in SKILL.md).

Usage:
    canvas roadmap read "<name>" | python3 render-snapshot.py [--date YYYY-MM-DD]
    python3 render-snapshot.py <live.json> [--date YYYY-MM-DD]

--date is the "snapshot taken" date; defaults to today. Pass it explicitly
when the caller already knows the date (keeps runs deterministic/testable).
"""
import datetime
import json
import sys

OUT_GLYPH = {"planned": "○", "in-progress": "◐", "done": "✓", "parked": "–"}
# Reader-first order: what's live and upcoming before what's already shipped.
ZONE_ORDER = [
    ("now", "Now — in progress"),
    ("next", "Next"),
    ("later", "Later — ranked, not committed"),
    ("done", "Done — shipped"),
]


def parse_args(argv):
    src, date = None, None
    it = iter(argv[1:])
    for a in it:
        if a == "--date":
            date = next(it, None)
        elif not a.startswith("-") and src is None:
            src = a
    return src, date


def load(src):
    raw = open(src).read() if src else sys.stdin.read()
    r = json.loads(raw)
    # `canvas roadmap read` returns {ok, rev, data:{...}}; tolerate a bare doc too.
    doc = r.get("data", r)
    rev = r.get("rev")
    return doc, rev


def render(doc, rev, snapshot_date):
    meta = doc.get("meta", {})
    title = meta.get("title", "Roadmap")
    updated = meta.get("updated", "unknown")
    L = []
    w = L.append

    w(f"# {title}")
    w("")
    w("> [!IMPORTANT]")
    w("> **This file is a published *snapshot*, not the source of truth.**")
    w("> The live roadmap is the **canvas roadmap control** in the EnsembleWorks")
    w("> room. Humans re-prioritise it directly on the canvas — drag across zones,")
    w("> reorder, click a status glyph — and those edits land there, **not here**.")
    w("> This Markdown does not sync back and will drift the moment the canvas changes.")
    w(">")
    w(f"> - **Snapshot taken:** {snapshot_date}")
    w(f"> - **Roadmap revision at snapshot:** rev {rev}")
    w(f"> - **Roadmap last changed on canvas:** {updated}")
    w('> - **Read the live version:** `canvas roadmap read "<name>"`')
    w("> - **Regenerate this snapshot:** re-run `/roadmap publish` — never hand-edit; edits belong on the canvas.")
    w("")
    w("Status key: ✓ done · ◐ in progress · ○ planned · – parked. "
      "Metrics show `[x]` met / `[ ]` not yet.")
    w("")

    for zone_id, zone_label in ZONE_ORDER:
        outs = [o for o in doc.get("outcomes", []) if o.get("zone") == zone_id]
        if not outs:
            continue
        w(f"## {zone_label}")
        w("")
        for o in outs:
            g = OUT_GLYPH.get(o.get("status"), "?")
            w(f"### {g} {o['title']}  <sub>`{o['key']}`</sub>")
            if o.get("why"):
                w(f"*{o['why']}*")
                w("")
            for i in o.get("initiatives", []):
                ig = OUT_GLYPH.get(i.get("status"), "?")
                w(f"- **{ig} {i['title']}**  <sub>`{i['key']}`</sub>")
                if i.get("statement"):
                    w(f"  - _{i['statement']}_")
                for m in i.get("metrics", []):
                    box = "x" if m.get("done") else " "
                    w(f"  - [{box}] _metric:_ {m['text']}")
                for f in i.get("features", []):
                    fg = OUT_GLYPH.get(f.get("status"), "?")
                    w(f"  - {fg} {f['text']}")
            if not o.get("initiatives"):
                w("- _(no initiatives detailed yet)_")
            w("")

    return "\n".join(L) + "\n"


def main():
    src, date = parse_args(sys.argv)
    if not date:
        date = datetime.date.today().isoformat()
    doc, rev = load(src)
    sys.stdout.write(render(doc, rev, date))


if __name__ == "__main__":
    main()
