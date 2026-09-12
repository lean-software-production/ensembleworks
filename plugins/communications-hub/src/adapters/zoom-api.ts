import { z } from 'zod';

/**
 * Zoom REST calls for creating and naming meetings.
 *
 * Separate from the RTMS adapter on purpose. RTMS is push: Zoom signs a webhook and we
 * open a socket, using the General app's client id and secret only to sign the handshake.
 * This module is pull, and needs a Server-to-Server OAuth credential that can act on the
 * account. The two sets of credentials are not interchangeable, and neither is reachable
 * from an agent tool.
 */

const TOKEN_URL = 'https://zoom.us/oauth/token';
const API_BASE = 'https://api.zoom.us/v2';
/** Refresh early so a call never travels with a token that expires in flight. */
const EXPIRY_MARGIN_MS = 60_000;

export interface ZoomApiCredentials {
  accountId: string;
  clientId: string;
  clientSecret: string;
}

export interface ZoomApiDependencies {
  fetch: typeof globalThis.fetch;
  now(): number;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
}).passthrough();

const meetingResponseSchema = z.object({
  id: z.union([z.number(), z.string()]),
  join_url: z.string().min(1).max(2_048),
  topic: z.string().optional(),
  host_id: z.string().optional(),
  password: z.string().optional(),
}).passthrough();

export interface CreatedMeeting {
  meetingId: string;
  joinUrl: string;
  topic: string;
  /** When the recurrence runs out and the room stops working. */
  expiresAt: number;
}

/**
 * A recurring meeting with a fixed time: one meeting id and one join URL across occurrences.
 *
 * Not the no-fixed-time variant, which would never expire but refuses registration outright -
 * `approval_type` is stored as 2 whatever is sent, a PATCH returns 204 and changes nothing,
 * and adding a registrant fails. Registration is the only way to carry a chosen name into a
 * meeting, so a room accepts an end date to get it.
 *
 * The scheduled time is nominal: a meeting whose first occurrence was eight days away accepted
 * a join immediately and captured normally. The recurrence is therefore a lifespan rather than
 * a schedule - nobody waits for an occurrence, they just join.
 */
const RECURRING_FIXED_TIME = 8;

/** Zoom's ceiling for a recurrence expressed as a count. A room stops working after these. */
export const MAX_OCCURRENCES = 60;

/**
 * Recur monthly rather than daily.
 *
 * The ceiling counts occurrences, not days, and occurrences are nominal because people join
 * whenever they like. Monthly therefore buys sixty months of room where daily bought sixty
 * days, for the same meeting id and the same join URL.
 */
const MONTHLY = 3;
const MONTH_MS = 30 * 86_400_000;

/** Keep the recurrence day inside every month, so no occurrence is skipped in February. */
function monthlyDay(nowMs: number): number {
  return Math.min(new Date(nowMs).getUTCDate(), 28);
}

/**
 * Meeting settings a room depends on.
 *
 * `waiting_room` must be false. A waiting room overrides join before host, so guests would
 * queue for a host who never arrives - measured, not assumed. Registration does not override
 * it, which was measured too.
 *
 * Nothing here enables transcript capture. RTMS auto-start is a per-user Zoom Apps setting
 * belonging to the host, not a meeting field, so the host must be the account that installed
 * the RTMS app.
 */
const ROOM_SETTINGS = {
  join_before_host: true,
  jbh_time: 0,
  waiting_room: false,
  // Registration is what lets BB choose the name a participant joins under. It also closes the
  // front door: the plain join URL lands on Zoom's registration form rather than the meeting,
  // so every route in produces a named participant. approval_type 0 approves automatically.
  approval_type: 0,
  // Register once, attend any occurrence: one personal link that keeps working.
  registration_type: 2,
  mute_upon_entry: false,
  auto_recording: 'none',
} as const;

const registrantResponseSchema = z.object({
  registrant_id: z.string().min(1),
  join_url: z.string().min(1).max(2_048),
}).passthrough();

export class ZoomApi {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private credentials: ZoomApiCredentials,
    private dependencies: ZoomApiDependencies,
  ) {}

  /**
   * Fetch and cache an account-credentials token.
   *
   * Server-to-Server OAuth has no user to redirect and no refresh token: the credential is
   * exchanged for a short-lived token on demand. Caching it keeps a burst of calls to one
   * exchange; Zoom rate-limits the token endpoint separately from the API.
   */
  private async accessToken(): Promise<string> {
    const current = this.token;
    if (current && current.expiresAt > this.dependencies.now()) return current.value;
    const basic = Buffer.from(`${this.credentials.clientId}:${this.credentials.clientSecret}`).toString('base64');
    const url = `${TOKEN_URL}?grant_type=account_credentials&account_id=${encodeURIComponent(this.credentials.accountId)}`;
    const response = await this.dependencies.fetch(url, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    });
    if (!response.ok) throw new Error(`Zoom rejected the Server-to-Server OAuth credential (${response.status})`);
    const parsed = tokenResponseSchema.parse(await response.json());
    const expiresAt = this.dependencies.now() + parsed.expires_in * 1_000 - EXPIRY_MARGIN_MS;
    this.token = { value: parsed.access_token, expiresAt };
    return parsed.access_token;
  }

  private async call(path: string, init: { method: string; body?: unknown }): Promise<unknown> {
    const token = await this.accessToken();
    const response = await this.dependencies.fetch(`${API_BASE}${path}`, {
      method: init.method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (response.status === 401) {
      // The cached token was rejected. Drop it so the next attempt exchanges the credential
      // again rather than replaying a token Zoom has already refused.
      this.token = null;
      throw new Error('Zoom rejected the access token. Check the Server-to-Server OAuth credential.');
    }
    if (!response.ok) throw new Error(`Zoom API request failed (${response.status})`);
    // Zoom answers a successful PATCH or DELETE with 204 and no body.
    if (response.status === 204) return null;
    return response.json();
  }

  /**
   * Create a reusable room meeting hosted by `hostUser`.
   *
   * `hostUser` is an email address or Zoom user id and must be the account that installed the
   * RTMS app. Server-to-Server OAuth acts on the account rather than a signed-in user, so
   * there is no implicit "me" to fall back on.
   */
  async createRoomMeeting(hostUser: string, topic: string): Promise<CreatedMeeting> {
    const startTime = new Date(this.dependencies.now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const body = {
      topic,
      type: RECURRING_FIXED_TIME,
      start_time: startTime,
      duration: 60,
      recurrence: { type: MONTHLY, repeat_interval: 1, monthly_day: monthlyDay(this.dependencies.now()), end_times: MAX_OCCURRENCES },
      settings: ROOM_SETTINGS,
    };
    const parsed = meetingResponseSchema.parse(
      await this.call(`/users/${encodeURIComponent(hostUser)}/meetings`, { method: 'POST', body }),
    );
    return {
      meetingId: String(parsed.id),
      joinUrl: parsed.join_url,
      topic: parsed.topic ?? topic,
      // Approximate: Zoom places occurrences on calendar months, which vary in length. Close
      // enough to warn well before a room stops working, which is all this is for.
      expiresAt: this.dependencies.now() + (MAX_OCCURRENCES - 1) * MONTH_MS,
    };
  }

  /**
   * Register a person and return the personal join URL Zoom issues for them.
   *
   * The returned URL carries a `tk=` token, and whoever opens it joins under the registered
   * name whether or not they are signed in to Zoom. That name is the only channel BB has for
   * carrying identity into a meeting: RTMS reports a display name and a per-connection id, and
   * never the registrant or their email.
   */
  async addRegistrant(meetingId: string, person: {email: string; firstName: string; lastName: string}): Promise<{registrantId: string; joinUrl: string}> {
    const parsed = registrantResponseSchema.parse(await this.call(
      `/meetings/${encodeURIComponent(meetingId)}/registrants`,
      { method: 'POST', body: { email: person.email, first_name: person.firstName, last_name: person.lastName } },
    ));
    return { registrantId: parsed.registrant_id, joinUrl: parsed.join_url };
  }

  /**
   * Push a room's recurrence out to a fresh sixty occurrences.
   *
   * The recurrence is a lifespan rather than a schedule, so renewal is simply restating it from
   * today. The meeting id and join URL are unchanged, which is the point: every personal link
   * already issued keeps working.
   */
  async renewRoomMeeting(meetingId: string): Promise<number> {
    const startTime = new Date(this.dependencies.now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
    await this.call(`/meetings/${encodeURIComponent(meetingId)}`, {
      method: 'PATCH',
      body: {
        start_time: startTime,
        duration: 60,
        recurrence: { type: MONTHLY, repeat_interval: 1, monthly_day: monthlyDay(this.dependencies.now()), end_times: MAX_OCCURRENCES },
      },
    });
    return this.dependencies.now() + (MAX_OCCURRENCES - 1) * MONTH_MS;
  }

  /**
   * Delete a meeting at Zoom.
   *
   * Irreversible, and it takes every personal link with it: the plain join URL and every
   * registrant's `tk=` URL stop working at once. Only worth doing when a room should become
   * unreachable, rather than merely retired - archiving alone leaves the meeting usable.
   */
  async deleteMeeting(meetingId: string): Promise<void> {
    await this.call(`/meetings/${encodeURIComponent(meetingId)}`, { method: 'DELETE' });
  }

  /** Read a meeting's topic. RTMS events carry no topic, so naming a capture needs this call. */
  async meetingTopic(meetingId: string): Promise<string | null> {
    const parsed = meetingResponseSchema.parse(
      await this.call(`/meetings/${encodeURIComponent(meetingId)}`, { method: 'GET' }),
    );
    const topic = parsed.topic?.trim();
    return topic ? topic : null;
  }
}
