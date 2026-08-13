# EnsembleWorks Roadmap

> [!IMPORTANT]
> **This file is a published *snapshot*, not the source of truth.**
> The live roadmap is the **canvas roadmap control** in the EnsembleWorks
> room. Humans re-prioritise it directly on the canvas — drag across zones,
> reorder, click a status glyph — and those edits land there, **not here**.
> This Markdown does not sync back and will drift the moment the canvas changes.
>
> - **Snapshot taken:** 2026-07-03
> - **Roadmap revision at snapshot:** rev 3
> - **Roadmap last changed on canvas:** 2026-07-02
> - **Read the live version:** `canvas roadmap read "<name>"`
> - **Regenerate this snapshot:** re-run `/roadmap publish` — never hand-edit; edits belong on the canvas.

Status key: ✓ done · ◐ in progress · ○ planned · – parked. Metrics show `[x]` met / `[ ]` not yet.

## Now — in progress

### ◐ Open EnsembleWorks to the public  <sub>`O3`</sub>
*The platform is proven internally; the next step is letting people outside the founding team in, on real-time infrastructure we can afford at scale.*

- **◐ Public access**  <sub>`O3.I1`</sub>
  - _FOR: prospective teams. OUTCOME: someone outside the founding team can join a room._
  - [ ] _metric:_ A non-founding user can join a room end-to-end
  - ◐ Make EnsembleWorks publicly reachable
- **◐ Self-hosted LiveKit**  <sub>`O3.I2`</sub>
  - _FOR: the operators. OUTCOME: real-time audio/video runs on our own LiveKit, not a hosted plan._
  - [x] _metric:_ Sessions run on self-hosted LiveKit
  - ✓ Switch from hosted to self-hosted LiveKit

## Next

### ○ Live-session capture polish  <sub>`O4`</sub>
*Transcription and the scribe work; these refine what they produce.*

- **○ Transcription & scribe refinements**  <sub>`O4.I1`</sub>
  - [ ] _metric:_ Transcript entries carry an accurate spatial stamp
  - ○ Fix the transcription spatial stamp
  - ○ Stop / start button for the scribe

### ○ Roadmap control refinements  <sub>`O5`</sub>
*The roadmap control shipped; early use surfaced sharp edges to file down.*

- **○ Roadmap card usability**  <sub>`O5.I1`</sub>
  - ○ Per-card ID shortcodes (address a card by its key)
  - ○ Collapsible 'done' items
  - ○ Distinguish metric-met from feature-done styling; put ✓ in the card text; add vertical card spacing

### ○ Presence & UI polish  <sub>`O6`</sub>
*Small quality-of-life fixes people keep asking for.*

- **○ Presence polish**  <sub>`O6.I1`</sub>
  - ○ Show when a person was last active
  - ○ Resize camera bubbles to viewport / screen resolution

## Later — ranked, not committed

### ○ canvas CLI as a first-class agent surface  <sub>`O7`</sub>
*Agents drive the room through the CLI, but key moves — reparenting a sticky, positional placement, frame ops — need raw shape JSON today or are not possible at all.*

- **○ Close the CLI gaps**  <sub>`O7.I1`</sub>
  - ○ Reparent a sticky between frames (canvas move --frame) — the key gap
  - ○ Positional awareness: read x/y/w/h; place with --x/--y/--lane
  - ○ First-class frame ops (new/rename/delete) and --page scoping
  - ○ Batch create and bulk select/act on notes

### ○ Canvas UX niceties & cost watch  <sub>`O8`</sub>
*A backlog of smaller UX wins, plus keeping an eye on real-time infrastructure cost.*

- **○ Backlog**  <sub>`O8.I1`</sub>
  - ○ Miro-style keyboard shortcuts
  - ○ Paste at cursor position
  - ○ Fix the right-hand xterm margin
  - ○ Surface teams
  - ○ Bring your own terminal to the shared canvas
  - ○ Find a cheaper real-time (LiveKit) option

## Done — shipped

### ✓ Real-time multiplayer canvas  <sub>`O1`</sub>
*A shared room only works if presence, video and terminals feel instant and never get in the way.*

- **✓ Live presence & video**  <sub>`O1.I1`</sub>
  - _FOR: everyone in a room. OUTCOME: you can see who is here and what they are looking at, without the video obscuring the canvas._
  - [x] _metric:_ Camera bubbles are decoupled from cursors so they do not obscure the canvas
  - [x] _metric:_ You can see your own video bubble
  - ✓ Headshot-only cursor (drop the tldraw username)
  - ✓ Per-user latency indicator
  - ✓ People on other pages are hidden
  - ✓ Unified mic / cam / spatial-audio control panel, top-right
  - ✓ Clearer mic / cam toggle state
- **✓ Reliable shared terminals**  <sub>`O1.I2`</sub>
  - _FOR: agents and humans sharing a terminal. OUTCOME: the terminal survives resize, copy/paste and flaky networks._
  - [x] _metric:_ Terminals hold their connection through network drops
  - ✓ Multi-user terminal resize bug fixed
  - ✓ Copy/paste fixed in xterm.js
- **✓ Live transcription, scribe & conversation mapping**  <sub>`O1.I3`</sub>
  - _FOR: people in a live session. OUTCOME: speech is captured live and the discussion can be diagrammed and minuted on the canvas._
  - [x] _metric:_ Transcript streams onto the canvas live
  - ✓ Dynamic transcription display (scribe flyout)
  - ✓ Conversation-map skill (live dialogue diagram)
  - ✓ Minutes / scribe skill

### ✓ Identity, access & self-hosting  <sub>`O2`</sub>
*Opening a shared room to real teams needs real logins, moderation and infrastructure we control.*

- **✓ Sign-in & identity**  <sub>`O2.I1`</sub>
  - _FOR: team members. OUTCOME: you join as your real GitHub identity, and agents commit as the org._
  - [x] _metric:_ Sign-in via GitHub OAuth works end-to-end
  - ✓ GitHub OAuth sign-in
  - ✓ EnsembleWorks git identity for agent commits
  - ✓ Boot / kick / block a user
  - ✓ Renamed and rebranded to EnsembleWorks
- **✓ Self-hosted infrastructure**  <sub>`O2.I2`</sub>
  - _FOR: the operators. OUTCOME: the platform runs on infrastructure we own and can see._
  - [x] _metric:_ Running on our own VPS
  - ✓ VPS hosting
  - ✓ Backing VM load (CPU / mem) visible in-app

