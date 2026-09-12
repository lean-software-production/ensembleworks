# Presence

Presence supplies anonymous, expiring whereabouts and typing awareness for BB.
Visible tabs send a location heartbeat every ten seconds. A lease expires after
25 seconds or is cleared when the tab is hidden, so activity is never retained
as history.

Threads viewed by another anonymous browser display a viewer-count badge in the
BB sidebar and a compact people icon in the thread header. Hovering the header
icon gives the exact summary; clicking it opens aggregate viewer and typing
details. The icon and sidebar badge turn amber while someone is typing.
Multiple tabs from the same browser count once, and the local browser is
excluded. The current Plugin SDK does not expose authenticated person identity,
so Presence does not claim names or avatars.

Replacement sidebars that preserve BB's `data-sidebar-thread-id` row attribute
receive the same badge through a cleanup-safe content-script fallback.

Typing pulses contain no draft text or character counts. They are throttled to
at most once per second and expire after three seconds.

Canvas cursors remain Canvas-scoped awareness; this plugin does not read or
write Canvas documents or membership.
