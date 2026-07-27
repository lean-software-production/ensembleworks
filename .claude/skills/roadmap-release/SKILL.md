---
name: roadmap-release
description: Move a shipped EW<n> card into its RELEASE: vX.Y.Z subframe under RELEASE NOTES and stamp its implementation PR link, on the EW Feedback & Roadmap page. Use when a want has shipped in a release ("EW5 shipped in 0.22.0, PR #NN"). Creates the release subframe if it doesn't exist yet, reparents the card, and writes the PR link as a real richText link.
---

# Skill: roadmap-release

The last box of the roadmap pipeline: when a card's want has **shipped**, move it
into the matching release subframe under **RELEASE NOTES** and link the PR that
delivered it.

Read [`docs/roadmap-pipeline.md`](../../../docs/roadmap-pipeline.md) first — the
frame map (RELEASE NOTES is a container of `RELEASE: vX.Y.Z` subframes), the move
mechanics, and the **PR-link `richText` technique** all live there. The link part
is fiddly: markdown doesn't render and `--text` strips the link, so the PR link
must go through `--props` with a `link` mark. Do not skip that section.

You are given: a card (`EW<n>` / shape id), a version (`X.Y.Z`), and a PR number.

## 1. Find or create the release subframe

```bash
ensembleworks canvas-v2 document > /tmp/board.json
RN=$(jq -r '.. | objects | select(.kind=="frame" and .props.name=="RELEASE NOTES") | .id' /tmp/board.json)
jq -r --arg v "RELEASE: v$VER" '.. | objects | select(.kind=="frame" and .props.name==$v) | .id' /tmp/board.json
```

If no `RELEASE: vX.Y.Z` subframe exists, create one inside RELEASE NOTES.
Releases stack newest-on-top, same width/x as the existing ones — read their
bounds and place the new frame above the most recent:

```bash
ensembleworks canvas-v2 frame "RELEASE NOTES"    # existing release subframe bounds
ensembleworks canvas shape --op create --type frame --frame "RELEASE NOTES" \
  --name "RELEASE: v<X.Y.Z>" --x <local-x> --y <local-y> --w <w> --h <h>
```

## 2. Move the card in

```bash
ensembleworks canvas-v2 frame "RELEASE: v<X.Y.Z>"   # find a free slot
ensembleworks canvas shape --op update --id <card-id> --frame "RELEASE: v<X.Y.Z>" \
  --x <free-x> --y <free-y>
```

`--x/--y` are frame-local. If the card was previously in a NOW/NEXT/LATER zone,
reparenting moves it out of there automatically.

## 3. Stamp the PR link

Put `PR: #<k>` on the ID line as a **real link** (see the pipeline doc's "Linking
a card to its PR"). Copy the `link`-mark shape verbatim from an already-linked
card, keeping the card's existing story lines. Write it via `--props` (never
`--text`, which drops the mark), and set `props.url` too:

```bash
HREF=https://github.com/lean-software-production/ensembleworks/pull/<k>
# read the card's current lines, then rebuild its richText with the PR link on line 1:
PROPS=$(jq -nc --arg href "$HREF" '{ url:$href, richText:{ type:"doc", attrs:{dir:"auto"}, content:[
  {type:"paragraph",attrs:{dir:"auto"},content:[
    {type:"text",text:"ID: EW<n>, User: <who>, PR: "},
    {type:"text",marks:[{type:"link",attrs:{href:$href,target:"_blank",rel:"noopener noreferrer nofollow",class:null,title:null}}],text:"#<k>"}
  ]},
  {type:"paragraph",attrs:{dir:"auto"},content:[{type:"text",text:"<As a … line>"}]},
  {type:"paragraph",attrs:{dir:"auto"},content:[{type:"text",text:"<I want … line>"}]},
  {type:"paragraph",attrs:{dir:"auto"},content:[{type:"text",text:"<So that … line>"}]}
]}}')
ensembleworks canvas shape --op update --id <card-id> --props "$PROPS"
```

## 4. Close the loop

```bash
ensembleworks canvas sticky "released EW<n> in v<X.Y.Z> (PR #<k>)" --frame ADVICE --author release
ensembleworks terminal status "$SESSION" done
```

## Notes

- **Verify it actually shipped** before moving — a card in RELEASE NOTES reads as
  "done" to the whole room. If the PR is still open, say so and stop.
- Match the version to the real release (`deploy/release.sh` bumps + tags
  `vX.Y.Z`); don't invent a version.
- Preserve the card's `EW<n>` id — it never changes, the PR is the
  implementation, not a new id.
