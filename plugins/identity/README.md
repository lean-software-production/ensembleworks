# Identity

Identity answers "who is who" on a shared BB server. It is the renamed Presence
plugin, and is growing toward named presence and thread ownership (see
`docs/superpowers/specs/2026-09-15-bb-machine-ownership-design.md`).

Identity is built for a high-trust team. It will trust the Cloudflare Access
headers and BB's own thread metadata to help people avoid mistakes and see who is
doing what. It is not an access control.

## Presence

Presence supplies anonymous, expiring whereabouts and typing awareness for BB.
Visible tabs send a location heartbeat every ten seconds. A lease expires after
25 seconds or is cleared when the tab is hidden, so activity is never retained
as history.

Threads viewed by another anonymous browser display a viewer-count badge in the
BB sidebar and a compact people icon in the thread header. Hovering the header
icon gives the exact summary; clicking it opens aggregate viewer and typing
details. The icon and sidebar badge turn amber while someone is typing.
Multiple tabs from the same browser count once, and the local browser is
excluded. Presence does not yet claim names or avatars.

Replacement sidebars that preserve BB's `data-sidebar-thread-id` row attribute
receive the same badge through a cleanup-safe content-script fallback.

Typing pulses contain no draft text or character counts. They are throttled to
at most once per second and expire after three seconds.

Canvas cursors remain Canvas-scoped awareness; this plugin does not read or
write Canvas documents or membership.

## Upgrading from Presence

The plugin id changed from `presence` to `identity`. On each BB server:

```
bb plugin remove presence
bb plugin install ./plugins/identity
```

Presence kept no durable state, so nothing is lost.
