---
name: publish-doc
description: Show a rich document (report, plan, storyboard, mockup) on the canvas — write it to a file and open a file-viewer; never publish team documents to public URLs.
---

# Skill: Publishing a document to the canvas

When the user wants to SEE a document — a report, plan, storyboard, dashboard,
mockup — write it to a file under your home directory and put it on the canvas:

    ensembleworks file open my-repo/docs/report.html
    # iterate: edit the file, then make every open viewer reload
    ensembleworks file refresh my-repo/docs/report.html

The canvas control is a portal onto the file on disk — nothing is uploaded.
Relative references (CSS, images, sibling JSON) resolve against the real
directory and just work.

Paths resolve against your current directory, then against your home — so the
file must live UNDER your home directory. If your working checkout is outside
it (some dev setups mount repos at /workspaces), write the document to a home
path and open it with `~/…` explicitly:

    ensembleworks file open ~/reports/plan.html

## Authoring guidance

- **Standalone HTML with inline CSS** is the sweet spot. Relative-path assets
  also work (the portal serves siblings).
- Support **light and dark** via `@media (prefers-color-scheme: dark)`.
- **No unguarded `localStorage`/`document.cookie`** — the document runs in an
  opaque-origin sandbox and unguarded access THROWS. Wrap in try/catch if you
  must feature-detect.
- Prefer **SVG charts** over `<canvas>` (renders identically, and mirrors
  better when richer shared-viewing lands).
- **Markdown is fine for prose** — `.md` files render as styled HTML (GFM).
- Anything else (images, PDFs, source files as the top document) shows an
  "unsupported type" page in v1.

## Presenting

- Tell the humans about the header's **Present** toggle — everyone else's
  viewer follows the presenter's scroll position ("Following <name> — stop"
  lets any viewer opt out).
- After each significant edit, run `ensembleworks file refresh <path>` so every
  open viewer reloads. The presenter's viewers land back at the presented spot.

## What NOT to do

- **Do not publish team documents to public URLs** (Cloudflare Pages, gists,
  etc.) — that route is retired. The one alternative: a claude.ai Artifact,
  only when the audience is a private Claude workspace rather than the canvas
  room.
- Do not hand-run a web server for this; the file-viewer replaces that.
