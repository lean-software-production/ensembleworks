# Presence

Presence supplies scoped, expiring typing awareness for BB thread composers.
It sends no draft text or character counts. A pulse is emitted at most once per
second, expires after three seconds, and is cleared when the composer empties,
submits, blurs, or unmounts.

Canvas cursors remain Canvas-scoped awareness; this plugin does not read or
write Canvas documents or membership.
