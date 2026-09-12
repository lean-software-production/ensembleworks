---
name: canvas-first
description: Explain or troubleshoot the Canvas plugin's thread cards and return-to-canvas navigation.
---

The canvas is a map of linked work. A linked shape's overview card shows the
real BB thread title and status; clicking opens the normal BB thread view.
Use the header's Back to canvas control to restore the originating page, camera,
and surviving selection. Several distinct visits to the same thread produce an
explicit location picker. A thread with no saved origin has an Open canvas entry.

Return bookmarks are local to this browser tab (bounded session storage), not
shared document data. Cross-browser links preserve the page only. Never infer
that another collaborator sees the same camera or selection. Missing pages use
the existing fallback; removed or reparented selections are filtered.

Cards are only for explicitly linked shapes. They are hidden for selected shapes
and scale with canvas zoom. Partially visible cards are clipped at viewport boundaries. Hide threads affects this canvas mount. A card
shows status, attention, activity count, and a bounded latest assistant response
excerpt rendered with BB’s Markdown component. Markdown links keep their own
actions; Open thread enters the full conversation. Excerpts refresh every 15 seconds for up to 20 visible cards; they are
not generated summaries or live token streams. Failed reads show a fallback. This experiment
does not replace the app startup route or embed a second chat composer.

Implementation: canvas/thread-overview*, canvas/thread-return*,
canvas/thread-navigation.ts, and canvas/panel/session-thread-return.ts.

Canvas appearance follows BB theme tokens through canvas/theme.ts and the shared
chrome palette. Neutral text/drawings and frames adapt for contrast; sticky-note
colours and explicit drawing colours are preserved. No document colours are rewritten.

Cards show a top-right running/idle/needs-input/failed badge and project/machine
context in the footer, resolved from BB’s live sidebar data. Missing host data
is labelled unavailable rather than guessed from the current canvas machine.
