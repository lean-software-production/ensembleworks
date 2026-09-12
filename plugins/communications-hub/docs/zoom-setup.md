# Zoom transcript capture setup

Communications Hub receives live Zoom meeting transcripts through Zoom Realtime Media Streams (RTMS). The integration requests transcript text only. It does not request audio, video, screen sharing, or chat.

Zoom currently requires a Zoom Developer Pack with available credits for RTMS. See Zoom's current [RTMS app setup](https://developers.zoom.us/docs/rtms/meetings/add-features/) and [transcript WebSocket quickstart](https://developers.zoom.us/docs/rtms/meetings/quickstart-websockets/).

**Two Zoom apps are needed, and they are not interchangeable.** A user-managed General app receives RTMS: Zoom signs a webhook and the plugin opens a socket, using that app's client id and secret only to sign the handshake. A Server-to-Server OAuth app makes REST calls out to Zoom, to create meeting rooms and register people for them. The General app cannot make those calls: it authenticates by browser redirect, while the `account_credentials` grant belongs to the Server-to-Server app type. Capture works with the General app alone; rooms and registrants need both.

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

## 2. Create the RTMS app

Its name is public: it appears in the consent notice every participant sees on joining, including browser guests. Name it for what it takes, such as "Meeting Transcripts".

1. In the [Zoom App Marketplace](https://marketplace.zoom.us/), create a user-managed General app.
2. On **Scopes**, add only `meeting:read:meeting_transcript`. REST RTMS control scopes and Zoom App SDK RTMS APIs are not used by this proof of concept.
3. On **Access**, enable event subscriptions and create a webhook subscription for Meeting RTMS Started, Meeting RTMS Stopped, and Meeting RTMS Interrupted.
4. Enter the public URL from step 1 as the event notification endpoint.
5. Copy the app's Client ID, Client Secret, and webhook Secret Token. Keep all three server-side.

Zoom documents the endpoint challenge and signature format in [Using webhooks](https://developers.zoom.us/docs/api/webhooks/). Configure the BB secret before pressing Zoom's **Validate** button because validation is signed too.

## 3. Create the Server-to-Server app

Skip this if you only want capture. It is required for meeting rooms and registrants, and for naming a capture after its Zoom topic.

Creating one usually needs account-owner or administrator rights.

1. In the Marketplace, **Develop > Build App > Server-to-Server OAuth**. Its name is private, so name it to sit obviously beside the first, such as "Meeting Transcripts - room scheduling".
2. **App Credentials** gives an Account ID, Client ID and Client Secret. All three stay server-side.
3. **Information** requires a company name and developer contact before the app can be activated.
4. On **Scopes**, add:

   | Scope | Needed for |
   | --- | --- |
   | `meeting:write:meeting:admin` | creating a room |
   | `meeting:read:meeting:admin` | naming a capture after the Zoom topic |
   | `meeting:update:meeting:admin` | changing a room after it is created |
   | `meeting:write:registrant:admin` | issuing a personal join link |
   | `meeting:delete:meeting:admin` | deleting a room at Zoom |

   Each is a separate failure: a missing scope returns 400 with the scope name in the message, and only when that particular call is made.
5. **Activate your app.** Server-to-Server apps are activated rather than installed, and issue no tokens until they are.

Leave event subscriptions off. This app receives nothing from Zoom, and its Secret Token has no place in BB - entering it over the RTMS app's webhook secret would break signature verification on real deliveries.

## 4. Configure Communications Hub

Open BB's plugin settings for Communications Hub and set:

| Setting | Zoom value |
| --- | --- |
| Zoom client ID | General app Client ID |
| Zoom client secret | General app Client Secret |
| Zoom webhook secret | Event subscription Secret Token |
| Enable Zoom capture | Leave off until endpoint validation succeeds |
| Zoom account ID | Server-to-Server Account ID |
| Zoom Server-to-Server client ID | Server-to-Server Client ID |
| Zoom Server-to-Server client secret | Server-to-Server Client Secret |
| Zoom host user | email of the account that installed the RTMS app |

The host user is the one most easily got wrong. RTMS auto-start is a per-user Zoom Apps setting, so a room hosted by any other account schedules correctly and then captures nothing.

Both secrets use BB's server-side secret settings. They are not sent to the plugin frontend and are never written to transcript or plugin logs.

Return to the Zoom app, validate the event notification endpoint, save the event subscription, and install the app for the operator's Zoom user. Then enable **Enable Zoom capture** in BB.

`bb communications status` reports `configured`, `enabled` and `canCreateRooms` separately, because the two credentials are independent.

## 5. Enable Zoom auto-start

As the installed operator, open Zoom settings and go to **Zoom Apps**. Under **Auto-start apps that access shared realtime meeting content**, choose the General app. An account administrator may also need to allow apps to access shared real-time meeting content.

Communications Hub accepts start events only when Zoom marks the operator as the original host. Alternate-host, attendee, and webinar events do not start capture. Capture begins from Zoom auto-start or Zoom's own in-meeting host controls; the plugin does not perform an OAuth flow and does not call Zoom's start API.

## 6. Verify with a real meeting

1. Host a new Zoom meeting as the operator who installed the app. The app owner does not have to be present — see [Validated behaviour](#validated-behaviour-2026-09-11) — but if they do join, they must stay for the whole meeting, because the stream stops when they leave.
2. Complete any Zoom consent prompt for shared real-time meeting content.
3. Speak after RTMS starts, then open Communications Hub in BB.
4. Confirm a Zoom conversation appears, its capture state becomes **capturing**, and new transcript segments arrive.
5. Stop RTMS from Zoom or use **Stop capture** in BB. The BB control closes this instance's RTMS connection; Zoom remains the authority for its upstream RTMS session and consent controls.

If rooms are configured, `bb communications create-room "Verification"` then `bb communications register <room-id> <name> <email>` checks the rest of the path: the capture should be named after the room and carry its room id, and segments should show the registered name without anyone typing it.

Protocol tests cannot replace this check. It requires real Zoom credentials, an installed app, account policy, credits, network access to Zoom's WSS endpoints, and a live meeting.

## 7. Meeting rooms and registrants

A room is one reusable Zoom meeting that BB created and owns. Its join URL never changes, and every sitting in it becomes its own conversation, because Zoom issues a fresh `meeting_uuid` each time the room goes from empty to occupied. The room is what gathers those sittings together, and a BB thread can follow a room rather than one sitting, so it does not go stale when the room empties and refills.

Create one from the Communications page or with `bb communications create-room <name>`. Creating a meeting is deliberately not an agent tool: transcript text sits in an agent's context, so a sentence spoken in a meeting must never be able to spend money or send an invitation.

Each room is a recurring meeting with a fixed time, sixty monthly occurrences. The scheduled times are nominal - people join whenever they like - so the recurrence is a lifespan rather than a schedule, and the room works for about five years. The UI warns once expiry is within sixty days. **Renew** restates the same meeting from today, so the meeting id, the join URL and every personal link already issued are unchanged - use `bb communications renew-room <room-id>` or the button on the room. Archiving is local: the Zoom meeting is left alone, so an old join URL keeps working and past conversations stay readable. **Delete at Zoom** is the stronger option and asks for confirmation first: it deletes the meeting, so the plain join URL and every personal link stop working at once. The room row and its registrant list are kept as the record of who held a link, and past sittings stay readable either way.

Rooms have registration enabled, which is what lets BB choose the name a participant joins under. Register someone from the room's card or with `bb communications register <room-id> <name> <email>`. They get a personal join URL: whoever opens it joins under the registered name, signed in to Zoom or not, and it is valid for every occurrence. The plain room URL asks anyone else to register first, so there is no unnamed way in.

This is identity by convention, not proof. A stranger holding the plain link can register under any name, and Zoom lets participants rename themselves mid-meeting unless that is disabled in meeting settings. What registration buys is that the ordinary path for your own team produces the right name without anybody typing it.

Transcript attribution follows the display name for that reason. The participant id Zoom sends identifies a connection rather than a person - one human joining from two browsers produces two - so it is used only to separate unattributed speech.

## Capture coverage and recovery

Transcript timestamps are relative to a stable capture anchor: the first accepted `meeting.rtms_started` event for that Zoom meeting occurrence. They may therefore differ from the meeting's actual start time. The anchor is persisted so reconnects and plugin reloads keep the same timeline.

The adapter reports **interrupted** before retrying a dropped connection, uses bounded exponential retries, and never claims that missing speech was recovered. It does not request retroactive transcript history. Repeated delivery of the same Zoom transcript packet is deduplicated by its speaker, absolute source times, and text. A later RTMS start for the same occurrence replaces stale sockets while retaining the original capture anchor.

For wire-level troubleshooting, consult Zoom's current [working with streams](https://developers.zoom.us/docs/rtms/meetings/work-with-streams/), [event reference](https://developers.zoom.us/docs/rtms/event-reference/), and [failover and reconnection](https://developers.zoom.us/docs/rtms/meetings/failover-reconnection/) documentation.

## Validated behaviour (2026-09-11)

Measured against live meetings, not inferred from documentation.

**Capture does not require the app owner in the meeting.** With auto-start enabled, `meeting.rtms_started` fires for a meeting the app-owner account never joins, including when the only participant is an unauthenticated guest in a browser. Earlier belief that a desktop client was required was wrong: the confound was that the app owner and the desktop user were the same person. The documented constraint is that the stream stops when the app owner *leaves*, so an owner who never joins never triggers it.

This makes an owner-scheduled, join-before-host meeting a viable persistent room. Waiting room must be off, or it overrides join-before-host and guests wait for a host who will never arrive.

**Guests receive the consent prompt.** The notice about an app accessing shared real-time meeting content appears on a browser guest join, not only for signed-in desktop users.

**Guest display names are self-asserted.** The speaker recorded on every segment is whatever text the participant typed at join. The same person across two occurrences produced two different names with nothing linking them. *Since addressed: rooms register their participants, so the name is one BB issued - see [registrants](#7-meeting-rooms-and-registrants) and the 2026-09-12 findings on `user_id`.*

**Claiming host does not interrupt capture** when done with the app-owner account's host key: no new webhook, no interruption, no reconnect. Host transfer to an account *without* RTMS permission is documented to close the socket and require a fresh start event, and remains untested and unhandled.

**A recurring meeting fragments into one conversation per occupancy period.** Conversations are keyed on `meeting_uuid`, which changes per occurrence while the meeting ID stays constant. Leaving and rejoining 70 seconds later produced two conversations with identical titles. A thread attached to the first goes stale silently. *Since fixed: sittings belong to a room, and a thread can follow the room instead.*

**Stream duration cannot be computed from stored data.** There is no `captureEndedAt`; `lastReceivedAt` records the last segment, so any trailing silence is invisible. Measured against exact webhook timestamps, the stored estimate ran 35–37% low across two meetings. Cost accounting needs the real end time.

**`stop_reason` is unreachable.** The webhook's stop reason is classified in `finishCapture`, but the signaling socket's stream-state message calls `end()` first and sets the session terminal, so the webhook's refinement is dropped. Every stored conversation carries a socket-derived detail string. This is why a client crash and a deliberate leave are indistinguishable in our data: Zoom distinguishes them and we discard the field. *Since fixed: a finished capture stays addressable long enough for the webhook to record its reason.*

**RTMS events carry no meeting topic.** Confirmed by logging the field names of a real `rtms_started` payload: `account_id`, `is_original_host`, `meeting_id`, `meeting_uuid`, `operator_id`, `rtms_stream_id`, `server_urls`. Nothing was hidden behind the passthrough schemas. *Since addressed: a room's sitting is named after the room without any API call, and other meetings are named from `GET /v2/meetings/{meetingId}` after capture has started.* Renaming by hand still works and still wins over the automatic name.

**Credit usage is reported under Plans and Billing > Plan Management**, on the Developer Pack card, metered separately for RTMS with and without transcription. It updates only every 24 hours, so same-day usage reads as zero.

**One credit buys about 50 streaming minutes with transcription.** The day after the meetings above, Plan Management read 1 of 20 credits for 50 streaming minutes, against a predicted 40-57 minutes. Zoom's figure exceeded the 28.62 minutes derivable from `lastReceivedAt`, which is consistent with Zoom billing the whole socket lifetime, trailing silence and failed captures included. Estimate stream cost from `captureStartedAt` and `captureEndedAt`, never from segment times.

## Validated behaviour (2026-09-12)

Measured against live Zoom with a Server-to-Server OAuth credential.

**BB-created meetings auto-start RTMS.** A meeting created through the API inherits auto-start from the host user's Zoom Apps setting, so the host must be the account that installed the RTMS app. Verified for both a recurring meeting with no fixed time (type 3) and a recurring meeting with a fixed time (type 8).

**A room's sittings can be gathered.** The Zoom meeting id is stable across occurrences while `meeting_uuid` is not, so the id is what links each sitting to its room. Two sittings of one room both carried its room id.

**`user_id` identifies a connection, not a person.** Every capture with a single participant reported `16778240`, which is `0x1000000` - a per-session counter starting from the same base in every meeting. Two different people in two different meetings shared it. Within one occurrence the ids do differ: one person joining from two browsers produced `16778240` and `16791552`. So the field separates simultaneous speakers and nothing more. A `user_id` to identity mapping would confidently misattribute.

**Registration is refused on recurring meetings with no fixed time, silently.** `approval_type: 0` is accepted at creation and stored as `2`; a `PATCH` returns 204 and changes nothing; adding a registrant then fails with "Registration has not been enabled for this meeting". An otherwise identical scheduled meeting (type 2) stored `approval_type: 0` and accepted a registrant, so it is the meeting type and not the request.

**A recurring meeting with a fixed time (type 8) accepts registration.** It keeps one meeting id and one join URL like type 3, and with `registration_type: 2` one registrant link is valid for every occurrence. `join_before_host` survives alongside registration, unlike a waiting room.

**A registrant link sets the display name**, signed in or not. Both a signed-in browser and an incognito one reported the registered name without the participant typing anything.

**The plain join URL does not bypass registration**: it lands on Zoom's registration form. Every route into the meeting therefore produces a named participant. Registration is a gate rather than proof - a stranger with the plain link can register under any name - but a BB-issued link carries a name BB chose.

**Scheduled occurrence times are nominal.** A type 8 meeting whose first occurrence was eight days away accepted a join immediately and captured normally.

**A type 8 room expires.** The recurrence needs an end: at most 60 occurrences or a fixed end date. Nothing renews it, so the room stops working on a date nobody is watching.

**Reading a meeting topic needs its own scope.** Naming a capture from Zoom's topic uses `GET /meetings/{id}` and fails with 400 until `meeting:read:meeting:admin` is granted. Registrants need `meeting:write:registrant:admin`, and changing a meeting after creation needs `meeting:update:meeting:admin`.
