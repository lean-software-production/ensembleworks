# Zoom transcript capture setup

Communications Hub receives live Zoom meeting transcripts through Zoom Realtime Media Streams (RTMS). The integration requests transcript text only. It does not request audio, video, screen sharing, or chat.

Zoom currently requires a Zoom Developer Pack with available credits for RTMS. The app must be a user-managed General app installed for the operator who hosts the meetings. See Zoom's current [RTMS app setup](https://developers.zoom.us/docs/rtms/meetings/add-features/) and [transcript WebSocket quickstart](https://developers.zoom.us/docs/rtms/meetings/quickstart-websockets/).

## 1. Publish only the webhook route

Zoom requires a publicly reachable HTTPS endpoint with a valid certificate and TLS 1.2 or newer. Put a gateway or reverse proxy in front of BB that exposes only this exact plugin route:

```text
POST /api/v1/plugins/<plugin-id>/http/zoom/webhook
```

Forward that path to the same path on the BB server. Reject every other path at the public gateway. Do not publish the BB application, API, WebSocket, or plugin routes as a group. Replace `<plugin-id>` with the installed plugin ID shown by `bb plugin list`.

The resulting event notification endpoint resembles:

```text
https://communications.example.com/api/v1/plugins/<plugin-id>/http/zoom/webhook
```

The adapter authenticates this unauthenticated HTTP route itself. It checks Zoom's `x-zm-request-timestamp` and `x-zm-signature` against the unmodified request body, accepts a five-minute clock window, and rejects replayed signatures. A gateway must preserve the body bytes and these headers.

### A local gateway and tunnel for testing

`tools/zoom-webhook-gateway.mjs` is a minimal gateway for a development machine. It listens on a local port, forwards only the exact webhook path to the BB server with the body bytes and Zoom signature headers unmodified, and answers every other path with 404.

```sh
node tools/zoom-webhook-gateway.mjs --port 8787
cloudflared tunnel --url http://127.0.0.1:8787 --no-autoupdate
```

Point the tunnel at the gateway port, never at the BB server port. A quick `trycloudflare.com` tunnel needs no Cloudflare account, but its hostname changes on every restart, so Zoom's endpoint URL must be re-entered and re-validated each session. Use a named tunnel or another stable host for anything beyond a single test.

Check the published endpoint before configuring Zoom. Before the webhook secret is set, BB answers the webhook path with `503 Zoom webhook is not configured`; any other path must answer 404 at the gateway.

## 2. Create the Zoom app

1. In the [Zoom App Marketplace](https://marketplace.zoom.us/), create a user-managed General app.
2. On **Scopes**, add only `meeting:read:meeting_transcript`. REST RTMS control scopes and Zoom App SDK RTMS APIs are not used by this proof of concept.
3. On **Access**, enable event subscriptions and create a webhook subscription for Meeting RTMS Started, Meeting RTMS Stopped, and Meeting RTMS Interrupted.
4. Enter the public URL from step 1 as the event notification endpoint.
5. Copy the app's Client ID, Client Secret, and webhook Secret Token. Keep all three server-side.

Zoom documents the endpoint challenge and signature format in [Using webhooks](https://developers.zoom.us/docs/api/webhooks/). Configure the BB secret before pressing Zoom's **Validate** button because validation is signed too.

## 3. Configure Communications Hub

Open BB's plugin settings for Communications Hub and set:

| Setting | Zoom value |
| --- | --- |
| Zoom client ID | General app Client ID |
| Zoom client secret | General app Client Secret |
| Zoom webhook secret | Event subscription Secret Token |
| Enable Zoom capture | Leave off until endpoint validation succeeds |

The client secret and webhook secret use BB's server-side secret settings. They are not sent to the plugin frontend and are never written to transcript or plugin logs.

Return to the Zoom app, validate the event notification endpoint, save the event subscription, and install the app for the operator's Zoom user. Then enable **Enable Zoom capture** in BB.

## 4. Enable Zoom auto-start

As the installed operator, open Zoom settings and go to **Zoom Apps**. Under **Auto-start apps that access shared realtime meeting content**, choose the General app. An account administrator may also need to allow apps to access shared real-time meeting content.

Communications Hub accepts start events only when Zoom marks the operator as the original host. Alternate-host, attendee, and webinar events do not start capture. Capture begins from Zoom auto-start or Zoom's own in-meeting host controls; the plugin does not perform an OAuth flow and does not call Zoom's start API.

## 5. Verify with a real meeting

1. Host a new Zoom meeting as the operator who installed the app. The app owner does not have to be present — see [Validated behaviour](#validated-behaviour-2026-09-11) — but if they do join, they must stay for the whole meeting, because the stream stops when they leave.
2. Complete any Zoom consent prompt for shared real-time meeting content.
3. Speak after RTMS starts, then open Communications Hub in BB.
4. Confirm a Zoom conversation appears, its capture state becomes **capturing**, and new transcript segments arrive.
5. Stop RTMS from Zoom or use **Stop capture** in BB. The BB control closes this instance's RTMS connection; Zoom remains the authority for its upstream RTMS session and consent controls.

Protocol tests cannot replace this check. It requires real Zoom credentials, an installed app, account policy, credits, network access to Zoom's WSS endpoints, and a live meeting.

## Capture coverage and recovery

Transcript timestamps are relative to a stable capture anchor: the first accepted `meeting.rtms_started` event for that Zoom meeting occurrence. They may therefore differ from the meeting's actual start time. The anchor is persisted so reconnects and plugin reloads keep the same timeline.

The adapter reports **interrupted** before retrying a dropped connection, uses bounded exponential retries, and never claims that missing speech was recovered. It does not request retroactive transcript history. Repeated delivery of the same Zoom transcript packet is deduplicated by its speaker, absolute source times, and text. A later RTMS start for the same occurrence replaces stale sockets while retaining the original capture anchor.

For wire-level troubleshooting, consult Zoom's current [working with streams](https://developers.zoom.us/docs/rtms/meetings/work-with-streams/), [event reference](https://developers.zoom.us/docs/rtms/event-reference/), and [failover and reconnection](https://developers.zoom.us/docs/rtms/meetings/failover-reconnection/) documentation.

## Validated behaviour (2026-09-11)

Measured against live meetings, not inferred from documentation.

**Capture does not require the app owner in the meeting.** With auto-start enabled, `meeting.rtms_started` fires for a meeting the app-owner account never joins, including when the only participant is an unauthenticated guest in a browser. Earlier belief that a desktop client was required was wrong: the confound was that the app owner and the desktop user were the same person. The documented constraint is that the stream stops when the app owner *leaves*, so an owner who never joins never triggers it.

This makes an owner-scheduled, join-before-host meeting a viable persistent room. Waiting room must be off, or it overrides join-before-host and guests wait for a host who will never arrive.

**Guests receive the consent prompt.** The notice about an app accessing shared real-time meeting content appears on a browser guest join, not only for signed-in desktop users.

**Guest display names are self-asserted.** The speaker recorded on every segment is whatever text the participant typed at join. The same person across two occurrences produced two different names with nothing linking them. RTMS also sends `user_id`, which is stable for the occurrence, but the adapter currently consumes it only into the dedup fingerprint and discards it.

**Claiming host does not interrupt capture** when done with the app-owner account's host key: no new webhook, no interruption, no reconnect. Host transfer to an account *without* RTMS permission is documented to close the socket and require a fresh start event, and remains untested and unhandled.

**A recurring meeting fragments into one conversation per occupancy period.** Conversations are keyed on `meeting_uuid`, which changes per occurrence while the meeting ID stays constant. Leaving and rejoining 70 seconds later produced two conversations with identical titles. A thread attached to the first goes stale silently.

**Stream duration cannot be computed from stored data.** There is no `captureEndedAt`; `lastReceivedAt` records the last segment, so any trailing silence is invisible. Measured against exact webhook timestamps, the stored estimate ran 35–37% low across two meetings. Cost accounting needs the real end time.

**`stop_reason` is unreachable.** The webhook's stop reason is classified in `finishCapture`, but the signaling socket's stream-state message calls `end()` first and sets the session terminal, so the webhook's refinement is dropped. Every stored conversation carries a socket-derived detail string. This is why a client crash and a deliberate leave are indistinguishable in our data: Zoom distinguishes them and we discard the field.

**RTMS events carry no meeting topic.** A capture names itself `Zoom meeting <id> · <UTC start>Z`; the timestamp is there because the meeting id repeats across occurrences of a recurring meeting. Rename the conversation in the transcript view or with `bb communications rename` to describe the discussion — the name survives reconnects, because `ensureConversation` never overwrites an existing title. Fetching Zoom's own topic needs a Server-to-Server OAuth credential and a `GET /v2/meetings/{meetingId}` call, which is not built.

**Credit usage is reported under Plans and Billing > Plan Management**, on the Developer Pack card, metered separately for RTMS with and without transcription. It updates only every 24 hours, so same-day usage reads as zero.

**One credit buys about 50 streaming minutes with transcription.** The day after the meetings above, Plan Management read 1 of 20 credits for 50 streaming minutes, against a predicted 40-57 minutes. Zoom's figure exceeded the 28.62 minutes derivable from `lastReceivedAt`, which is consistent with Zoom billing the whole socket lifetime, trailing silence and failed captures included. Estimate stream cost from `captureStartedAt` and `captureEndedAt`, never from segment times.
