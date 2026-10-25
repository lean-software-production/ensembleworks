import { describe, expect, it } from "vitest";
import { ZoomApi, type ZoomApiDependencies } from "../src/adapters/zoom-api.js";

const credentials = { accountId: "account-1", clientId: "api-client", clientSecret: "api-secret" };

interface Call { url: string; init: RequestInit | undefined }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fetch that answers the token endpoint and returns queued API responses in order. */
function stub(responses: Response[], options: { now?: () => number; tokenExpiresIn?: number } = {}) {
  const calls: Call[] = [];
  let tokenExchanges = 0;
  const dependencies: ZoomApiDependencies = {
    now: options.now ?? (() => 1_000),
    fetch: ((url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith("https://zoom.us/oauth/token")) {
        tokenExchanges++;
        return Promise.resolve(jsonResponse({
          access_token: `token-${tokenExchanges}`,
          expires_in: options.tokenExpiresIn ?? 3_600,
        }));
      }
      const next = responses.shift();
      if (!next) throw new Error(`unexpected request to ${url}`);
      return Promise.resolve(next);
    }) as unknown as typeof globalThis.fetch,
  };
  return { calls, dependencies, exchanges: () => tokenExchanges };
}

const meeting = { id: 88800011122, join_url: "https://zoom.us/j/88800011122?pwd=tok", topic: "Team standup" };

describe("Zoom REST client", () => {
  it("creates a reusable room meeting that guests can start", async () => {
    const { calls, dependencies } = stub([jsonResponse(meeting)]);
    const api = new ZoomApi(credentials, dependencies);

    const created = await api.createRoomMeeting("operator@example.com", "Team standup");

    expect(created).toMatchObject({
      meetingId: "88800011122",
      joinUrl: "https://zoom.us/j/88800011122?pwd=tok",
      topic: "Team standup",
    });
    const request = calls.at(-1)!;
    expect(request.url).toBe("https://api.zoom.us/v2/users/operator%40example.com/meetings");
    const body = JSON.parse(String(request.init?.body));
    // Type 8 is recurring with a fixed time. Type 3 would never expire but refuses registration
    // outright, and registration is the only way to carry a chosen name into a meeting.
    expect(body.type).toBe(8);
    // The ceiling counts occurrences, not days, and occurrences are nominal because people join
    // whenever they like. Monthly therefore buys sixty months where daily bought sixty days.
    expect(body.recurrence).toMatchObject({ type: 3, repeat_interval: 1, end_times: 60 });
    expect(body.recurrence.monthly_day).toBeLessThanOrEqual(28);
    // Registration is what lets BB choose the name a participant joins under, and it closes the
    // front door: the plain join URL lands on a registration form rather than the meeting.
    expect(body.settings.approval_type).toBe(0);
    // Register once, attend any occurrence: one personal link that keeps working.
    expect(body.settings.registration_type).toBe(2);
    // A waiting room overrides join before host, which would leave guests queueing for a host
    // who never arrives. Measured against a live meeting, so this assertion is load-bearing.
    expect(body.settings.waiting_room).toBe(false);
    expect(body.settings.join_before_host).toBe(true);
  });

  it("returns the meeting id as a string when Zoom sends a number", async () => {
    const { dependencies } = stub([jsonResponse({ ...meeting, id: 123 })]);
    const created = await new ZoomApi(credentials, dependencies).createRoomMeeting("host", "Room");
    // Zoom sends meeting ids as JSON numbers large enough to lose precision in comparisons
    // elsewhere, and every other identifier in the hub is a string.
    expect(created.meetingId).toBe("123");
  });

  it("reuses a cached token across calls", async () => {
    const { dependencies, exchanges } = stub([jsonResponse(meeting), jsonResponse(meeting)]);
    const api = new ZoomApi(credentials, dependencies);

    await api.createRoomMeeting("host", "One");
    await api.createRoomMeeting("host", "Two");

    expect(exchanges()).toBe(1);
  });

  it("exchanges the credential again once the token expires", async () => {
    let now = 1_000;
    const { dependencies, exchanges } = stub([jsonResponse(meeting), jsonResponse(meeting)], {
      now: () => now,
      tokenExpiresIn: 120,
    });
    const api = new ZoomApi(credentials, dependencies);

    await api.createRoomMeeting("host", "One");
    now += 120_000;
    await api.createRoomMeeting("host", "Two");

    expect(exchanges()).toBe(2);
  });

  it("drops a rejected token so the next call does not replay it", async () => {
    const { dependencies, exchanges } = stub([jsonResponse({}, 401), jsonResponse(meeting)]);
    const api = new ZoomApi(credentials, dependencies);

    await expect(api.createRoomMeeting("host", "One")).rejects.toThrow(/rejected the access token/);
    await api.createRoomMeeting("host", "Two");

    expect(exchanges()).toBe(2);
  });

  it("reports a rejected credential without leaking it", async () => {
    const dependencies: ZoomApiDependencies = {
      now: () => 0,
      fetch: (() => Promise.resolve(jsonResponse({}, 400))) as unknown as typeof globalThis.fetch,
    };
    await expect(new ZoomApi(credentials, dependencies).createRoomMeeting("host", "Room"))
      .rejects.toThrow("Zoom rejected the Server-to-Server OAuth credential (400)");
  });

  it("sends the credential as basic auth on the token request only", async () => {
    const { calls, dependencies } = stub([jsonResponse(meeting)]);
    await new ZoomApi(credentials, dependencies).createRoomMeeting("host", "Room");

    const token = calls[0]!;
    expect(token.url).toContain("grant_type=account_credentials");
    expect(token.url).toContain("account_id=account-1");
    const headers = token.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from("api-client:api-secret").toString("base64")}`);
    // The API call carries the bearer token, never the credential.
    const api = calls[1]!.init?.headers as Record<string, string>;
    expect(api.authorization).toBe("Bearer token-1");
  });

  it("reads a meeting topic and treats blank as absent", async () => {
    const { dependencies } = stub([jsonResponse({ ...meeting, topic: "Weekly planning" })]);
    await expect(new ZoomApi(credentials, dependencies).meetingTopic("123")).resolves.toBe("Weekly planning");

    const blank = stub([jsonResponse({ ...meeting, topic: "   " })]);
    await expect(new ZoomApi(credentials, blank.dependencies).meetingTopic("123")).resolves.toBeNull();
  });
});

describe("registrants", () => {
  const issued = { registrant_id: "Zw5D8sBxQ1KqMnEAS2NuiQ", join_url: "https://zoom.us/w/888?tk=token" };

  it("registers a person and returns their personal join URL", async () => {
    const { calls, dependencies } = stub([jsonResponse(issued, 201)]);

    const result = await new ZoomApi(credentials, dependencies)
      .addRegistrant("88800011122", { email: "david@example.com", firstName: "David", lastName: "Laing" });

    expect(result).toEqual({ registrantId: issued.registrant_id, joinUrl: issued.join_url });
    const request = calls.at(-1)!;
    expect(request.url).toBe("https://api.zoom.us/v2/meetings/88800011122/registrants");
    expect(JSON.parse(String(request.init?.body))).toEqual({
      email: "david@example.com", first_name: "David", last_name: "Laing",
    });
  });

  it("reports a refusal rather than inventing a link", async () => {
    // Zoom refuses registration on meetings that do not have it enabled. A stored registrant
    // with no working link would be worse than a visible failure.
    const { dependencies } = stub([jsonResponse({ code: 404 }, 400)]);
    await expect(new ZoomApi(credentials, dependencies)
      .addRegistrant("88800011122", { email: "d@example.com", firstName: "D", lastName: "L" }))
      .rejects.toThrow(/400/);
  });

  it("renews a room without changing its meeting or links", async () => {
    const now = Date.UTC(2027, 0, 15);
    const { calls, dependencies } = stub([new Response(null, { status: 204 })], { now: () => now });

    const expiresAt = await new ZoomApi(credentials, dependencies).renewRoomMeeting("88800011122");

    const request = calls.at(-1)!;
    expect(request.init?.method).toBe("PATCH");
    // The same meeting is restated, never replaced, so every personal link already issued
    // keeps working. A new meeting would silently invalidate them.
    expect(request.url).toBe("https://api.zoom.us/v2/meetings/88800011122");
    const body = JSON.parse(String(request.init?.body));
    expect(body.recurrence).toMatchObject({ type: 3, repeat_interval: 1, end_times: 60 });
    expect(expiresAt).toBeGreaterThan(now);
  });

  it("accepts an empty body from a successful update", async () => {
    // Zoom answers PATCH with 204 and no content, which is not parseable as JSON.
    const { dependencies } = stub([new Response(null, { status: 204 })]);
    await expect(new ZoomApi(credentials, dependencies).renewRoomMeeting("1")).resolves.toBeGreaterThan(0);
  });

  it("deletes a meeting at Zoom", async () => {
    const { calls, dependencies } = stub([new Response(null, { status: 204 })]);

    await new ZoomApi(credentials, dependencies).deleteMeeting("88800011122");

    const request = calls.at(-1)!;
    expect(request.init?.method).toBe("DELETE");
    expect(request.url).toBe("https://api.zoom.us/v2/meetings/88800011122");
  });

  it("reports a refused deletion rather than claiming the meeting is gone", async () => {
    // Recording a deletion that did not happen would leave the hub saying a room is unreachable
    // while its links still work.
    const { dependencies } = stub([jsonResponse({ code: 4711 }, 400)]);
    await expect(new ZoomApi(credentials, dependencies).deleteMeeting("1")).rejects.toThrow(/400/);
  });

  it("dates a room's expiry from its recurrence", async () => {
    const now = Date.UTC(2026, 8, 12);
    const { dependencies } = stub([jsonResponse(meeting)], { now: () => now });
    const created = await new ZoomApi(credentials, dependencies).createRoomMeeting("host", "Room");

    // Sixty monthly occurrences, so roughly five years rather than the sixty days a daily
    // recurrence would have bought. Approximate on purpose: it exists to warn, not to schedule.
    const years = (created.expiresAt - now) / (365 * 86_400_000);
    expect(years).toBeGreaterThan(4.5);
    expect(years).toBeLessThan(5.1);
  });
});
