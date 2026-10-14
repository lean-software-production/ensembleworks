# Communications Hub

Keep conversation context beside the work it informs. Import transcripts or connect Zoom capture, attach a BB thread, and let the agent search relevant passages with source links.

The single-instance MVP includes a conversation library, transcript viewer and search, independent thread attachments, explicit reading cursors, and a Zoom RTMS receiver. Zoom setup requires a General app and a reachable HTTPS webhook. Import works without Zoom configuration.

An optional Slack adapter indexes channels the bot has joined. BB threads can attach to a channel and use the same agent read/search tools and thread panel as transcript conversations; cross-channel search remains available. Slack messages retain their own editable source store. A separately enabled agent action posts to configured channels when a BB user explicitly requests it. DMs are excluded. Other chat adapters and automatic conversation windows are future work. See README.md for setup, operational limits and verification.
