type NativeThreadStatus = {
  icon: string;
  label: string;
  tone?: "default" | "error" | "running" | "success";
};

export type ThreadStatus = NativeThreadStatus & {
  /**
   * What the fallback badge shows on a replacement sidebar that renders no native
   * status: a viewer count for presence, a starter's initials for ownership.
   */
  badge: string;
  /** That badge's background, so presence and ownership read differently at a glance. */
  badgeColor: string;
  /**
   * The ink to draw the badge text in, chosen FROM `badgeColor` by `readableInk`
   * (person-colors.ts). Optional: a presence badge has always been white on a colour
   * picked to suit it, and stays that way.
   *
   * It exists because a person may now CHOOSE their colour. The badge used to hardcode
   * white, so pale yellow initials on pale yellow were simply invisible.
   */
  badgeInk?: string;
};

export type ThreadStatusSetter = (threadId: string, status: NativeThreadStatus | null) => void;

const BADGE_ATTRIBUTE = "data-bb-presence-badge";
const RESERVED_ATTRIBUTE = "data-bb-badge-reserved";

/** Keep clear of BB's working glyph while retaining room between the title and controls. */
const BADGE_RIGHT_PX = -18;
const BADGE_RESERVED_RIGHT_PX = 20;

/**
 * Reserve trailing room for the badge on the row.
 *
 * The badge is absolutely positioned, so it occupies no space of its own. Keep it after
 * the title, remember the host's existing padding, and restore that padding when the
 * badge goes away.
 */
function reserveBadgeRoom(anchor: HTMLElement): void {
  if (anchor.hasAttribute(RESERVED_ATTRIBUTE)) return;
  anchor.setAttribute(RESERVED_ATTRIBUTE, anchor.style.paddingRight);
  anchor.style.paddingRight = `${BADGE_RESERVED_RIGHT_PX}px`;
}

function releaseBadgeRoom(anchor: HTMLElement): void {
  if (!anchor.hasAttribute(RESERVED_ATTRIBUTE)) return;
  anchor.style.paddingRight = anchor.getAttribute(RESERVED_ATTRIBUTE) ?? "";
  anchor.removeAttribute(RESERVED_ATTRIBUTE);
}

let currentStatuses = new Map<string, ThreadStatus>();
let currentDocument: Document | null = null;
let nativeSetter: ThreadStatusSetter | null = null;
let observer: MutationObserver | null = null;
let reconcileQueued = false;

/** Update both BB's native rows and replacement sidebars that preserve BB row ids. */
export function replaceThreadStatuses(next: Map<string, ThreadStatus>): void {
  if (nativeSetter) {
    for (const threadId of currentStatuses.keys()) {
      if (!next.has(threadId)) nativeSetter(threadId, null);
    }
    for (const [threadId, status] of next) nativeSetter(threadId, nativeStatus(status));
  }
  currentStatuses = next;
  queueReconcile();
}

export function mountThreadStatusFallback(options: {
  document: Document;
  setNativeStatus?: ThreadStatusSetter;
}): () => void {
  currentDocument = options.document;
  nativeSetter = options.setNativeStatus ?? null;
  for (const [threadId, status] of currentStatuses) nativeSetter?.(threadId, nativeStatus(status));

  const MutationObserverConstructor = options.document.defaultView?.MutationObserver;
  if (MutationObserverConstructor) {
    observer = new MutationObserverConstructor(queueReconcile);
    observer.observe(options.document.documentElement, { childList: true, subtree: true });
  }
  reconcileFallbackDots();

  return () => {
    observer?.disconnect();
    observer = null;
    removeAllBadges(options.document);
    nativeSetter = null;
    currentDocument = null;
    currentStatuses = new Map();
    reconcileQueued = false;
  };
}

function queueReconcile(): void {
  if (reconcileQueued || currentDocument === null) return;
  reconcileQueued = true;
  queueMicrotask(() => {
    reconcileQueued = false;
    reconcileFallbackDots();
  });
}

function reconcileFallbackDots(): void {
  const document = currentDocument;
  if (!document) return;

  const liveBadges = new Set<Element>();
  for (const anchor of document.querySelectorAll<HTMLElement>("[data-sidebar-thread-id]")) {
    const threadId = anchor.getAttribute("data-sidebar-thread-id");
    const status = threadId === null ? undefined : currentStatuses.get(threadId);
    const existing = [...anchor.children].find((child) => child.hasAttribute(BADGE_ATTRIBUTE));
    const row = anchor.closest<HTMLElement>("[data-parent-card]") ?? anchor.parentElement ?? anchor;
    const nativeRendered = status ? hasNativeStatus(row, status.label) : false;

    if (!status) {
      existing?.remove();
      releaseBadgeRoom(anchor);
      continue;
    }

    if (nativeRendered) {
      // bb positioned its own glyph; reserving room for a badge we are not drawing would
      // indent the row for nothing.
      existing?.remove();
      releaseBadgeRoom(anchor);
      continue;
    }

    const badge = existing instanceof HTMLElement ? existing : createBadge(document);
    if (badge.textContent !== status.badge) badge.textContent = status.badge;
    badge.setAttribute("aria-label", status.label);
    badge.setAttribute("title", status.label);
    badge.style.background = status.badgeColor;
    // Reassigned on every paint, not only at creation: a colour change must take its ink
    // with it, or a repainted badge keeps the previous colour's ink.
    badge.style.color = status.badgeInk ?? "white";
    if (!existing) anchor.append(badge);
    reserveBadgeRoom(anchor);
    liveBadges.add(badge);
  }

  for (const badge of document.querySelectorAll("[" + BADGE_ATTRIBUTE + "]")) {
    if (!liveBadges.has(badge)) badge.remove();
  }
}

function hasNativeStatus(row: HTMLElement, label: string): boolean {
  return [...row.querySelectorAll<HTMLElement>("[aria-label]")].some((element) => (
    !element.hasAttribute(BADGE_ATTRIBUTE) && element.getAttribute("aria-label") === label
  ));
}

function createBadge(document: Document): HTMLSpanElement {
  const badge = document.createElement("span");
  badge.setAttribute(BADGE_ATTRIBUTE, "");
  badge.setAttribute("role", "status");
  Object.assign(badge.style, {
    position: "absolute",
    // Sit beyond BB's trailing working glyph instead of painting over it.
    right: `${BADGE_RIGHT_PX}px`,
    top: "50%",
    minWidth: "14px",
    height: "14px",
    padding: "0 3px",
    borderRadius: "9999px",
    boxShadow: "0 0 0 1px var(--sidebar-background, var(--background))",
    color: "white",
    fontSize: "9px",
    fontWeight: "700",
    lineHeight: "14px",
    textAlign: "center",
    pointerEvents: "none",
    transform: "translateY(-50%)",
    zIndex: "1",
  });
  return badge;
}

function nativeStatus(status: ThreadStatus): NativeThreadStatus {
  return { icon: status.icon, label: status.label, tone: status.tone };
}

function removeAllBadges(document: Document): void {
  for (const anchor of document.querySelectorAll<HTMLElement>("[" + RESERVED_ATTRIBUTE + "]")) releaseBadgeRoom(anchor);
  for (const badge of document.querySelectorAll("[" + BADGE_ATTRIBUTE + "]")) badge.remove();
}
