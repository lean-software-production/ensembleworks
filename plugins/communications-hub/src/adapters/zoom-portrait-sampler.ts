import type { PresenceEvent } from "../presence/roster.js";

/** Request one still, then stop upstream delivery. Never keeps a video subscription idle. */
export class ZoomPortraitSampler {
  private ready = false;
  private pending: string | null = null;
  private active: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly attempted = new Map<string, number>();

  constructor(private readonly send: (id: string, subscribe: boolean) => void,
    private readonly now: () => number = Date.now) {}

  event(event: PresenceEvent): void {
    if (event.kind === "left" || (event.kind === "camera" && !event.on)) {
      if (this.active === event.participantId) this.stop();
      if (this.pending === event.participantId) this.pending = null;
      if (event.kind === "left") this.attempted.delete(event.participantId);
      return;
    }
    if (event.kind !== "speaking" && !(event.kind === "camera" && event.on)) return;
    // Camera-on gets an initial portrait; later refreshes follow speaker events.
    if (event.kind === "camera" && this.attempted.has(event.participantId)) return;
    this.pending = event.participantId;
    this.request();
  }

  start(): void { this.ready = true; this.request(); }
  wants(id: string): boolean { return this.active === id; }
  captured(id: string): void { if (this.wants(id)) this.stop(); }
  rejected(id: string): void { if (this.wants(id)) this.stop(); }

  reset(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.active = this.pending = null;
    this.ready = false;
    this.attempted.clear();
  }

  private request(): void {
    if (!this.ready || !this.pending) return;
    const id = this.pending;
    this.pending = null;
    if (this.active === id) return;
    // Stop the previous speaker even if the new speaker already has a recent still.
    this.stop();
    const now = this.now();
    if (now - (this.attempted.get(id) ?? -Infinity) < 30_000) return;
    // Zoom participant IDs are numeric; never send arbitrary event strings as IDs.
    if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id))) return;
    this.attempted.delete(id);
    this.attempted.set(id, now);
    while (this.attempted.size > 128) this.attempted.delete(this.attempted.keys().next().value!);
    this.active = id;
    this.timer = setTimeout(() => this.stop(), 5_000);
    this.send(id, true);
  }

  private stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const id = this.active;
    this.active = null;
    if (id !== null) this.send(id, false);
  }
}
