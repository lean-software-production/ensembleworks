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
  /**
   * The starter's photo, drawn in place of `badge` when present. The badge is injected
   * DOM rather than React, so this is a URL and the photo-then-initials rule is applied
   * by hand in `paintBadgeContent`; `badge` remains the text shown when the photo fails.
   */
  avatarUrl?: string | null;
  /**
   * Named viewers, each drawn as its own ringed circle (photo, or `badge` initials when
   * the photo fails), overlapping like the header bubbles. When non-empty this REPLACES
   * the single `badge`; `overflow` anonymous viewers trail it as one "+N" circle.
   */
  stack?: readonly StackedPerson[];
  overflow?: number;
};

export type StackedPerson = {
  avatarUrl: string | null;
  /** Initials, shown when there is no photo. */
  badge: string;
  color: string;
  ink: string;
  /** The ring: green for viewing, amber for typing. */
  ring: string;
};

export type ThreadStatusSetter = (threadId: string, status: NativeThreadStatus | null) => void;

const BADGE_ATTRIBUTE = "data-bb-presence-badge";

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
    const row = anchor.closest<HTMLElement>("[data-parent-card]") ?? anchor.parentElement ?? anchor;
    const existing = row.querySelector<HTMLElement>("[" + BADGE_ATTRIBUTE + "]");
    const badgeHost = badgeHostFor(anchor);
    const nativeRendered = status ? hasNativeStatus(row, status.label) : false;

    if (!status || badgeHost === null) {
      existing?.remove();
      continue;
    }

    if (nativeRendered) {
      // BB already positioned this status in its own row chrome.
      existing?.remove();
      continue;
    }

    const badge = existing instanceof HTMLElement ? existing : createBadge(document);
    badge.setAttribute("aria-label", status.label);
    badge.setAttribute("title", status.label);
    if (status.stack !== undefined && status.stack.length > 0) {
      paintStack(document, badge, status.stack, status.overflow ?? 0);
    } else {
      // Reassigned on every paint, not only at creation: a colour change must take its
      // ink with it, or a repainted badge keeps the previous colour's ink.
      paintCircle(document, badge, {
        avatarUrl: status.avatarUrl ?? null, text: status.badge,
        color: status.badgeColor, ink: status.badgeInk ?? "white", ring: null,
      });
    }
    if (badge.parentElement !== badgeHost) badgeHost.prepend(badge);
    liveBadges.add(badge);
  }

  for (const badge of document.querySelectorAll("[" + BADGE_ATTRIBUTE + "]")) {
    if (!liveBadges.has(badge)) badge.remove();
  }
}

/** BB's full-row link is an empty absolute overlay; its next sibling owns title layout. */
function badgeHostFor(anchor: HTMLElement): HTMLElement | null {
  return anchor.nextElementSibling instanceof HTMLElement ? anchor.nextElementSibling : null;
}

function hasNativeStatus(row: HTMLElement, label: string): boolean {
  return [...row.querySelectorAll<HTMLElement>("[aria-label]")].some((element) => (
    !element.hasAttribute(BADGE_ATTRIBUTE) && element.getAttribute("aria-label") === label
  ));
}

function createBadge(document: Document): HTMLSpanElement {
  const badge = createCircle(document);
  badge.style.position = "";
  badge.setAttribute(BADGE_ATTRIBUTE, "");
  badge.setAttribute("role", "status");
  return badge;
}

const FAILED_AVATAR_ATTRIBUTE = "data-avatar-failed";
const STACK_ITEM_ATTRIBUTE = "data-bb-presence-stack-item";
const CIRCLE_SIZE = "14px";

type Circle = {
  avatarUrl: string | null;
  /** Shown when there is no photo: initials, a count, "+N". */
  text: string;
  color: string;
  ink: string;
  /** A ring colour, or null for the ringless single badge. */
  ring: string | null;
};

/**
 * One circle: photo first, text only when there is no photo — the same rule as
 * `Avatar.tsx`, by hand because this badge is plain DOM. A URL that failed once is
 * remembered on the element so a repaint does not re-request it; a different URL gets a
 * fresh try. The fill is always painted so it shows while the photo loads.
 */
function paintCircle(document: Document, element: HTMLElement, circle: Circle): void {
  element.style.background = circle.color;
  element.style.color = circle.ink;
  if (circle.ring === null) {
    element.style.borderWidth = ""; element.style.borderStyle = ""; element.style.borderColor = "";
  } else {
    element.style.borderWidth = "1.5px"; element.style.borderStyle = "solid"; element.style.borderColor = circle.ring;
    element.style.boxSizing = "border-box";
  }
  const url = circle.avatarUrl;
  const failed = element.getAttribute(FAILED_AVATAR_ATTRIBUTE);
  if (failed !== null && failed !== url) element.removeAttribute(FAILED_AVATAR_ATTRIBUTE);
  const showPhoto = url !== null && element.getAttribute(FAILED_AVATAR_ATTRIBUTE) !== url;
  const img = element.querySelector("img");
  if (showPhoto) {
    // A photo is square: drop the text padding so the circle stays a circle.
    element.style.width = CIRCLE_SIZE;
    element.style.padding = "0";
    element.style.overflow = "hidden";
    if (img !== null && img.getAttribute("src") === url) return;
    const next = document.createElement("img");
    next.setAttribute("src", url);
    next.setAttribute("alt", "");
    Object.assign(next.style, { width: "100%", height: "100%", objectFit: "cover", display: "block" });
    next.addEventListener("error", () => {
      element.setAttribute(FAILED_AVATAR_ATTRIBUTE, url);
      next.remove();
      paintCircle(document, element, circle);
    });
    element.replaceChildren(next);
    return;
  }
  element.style.width = "";
  element.style.padding = "0 3px";
  element.style.overflow = "";
  if (img !== null || element.textContent !== circle.text) element.textContent = circle.text;
}

/**
 * The badge as a row of overlapping circles, one per named viewer plus one "+N" for the
 * anonymous rest. Children are reused by position so a circle's photo-failure memory
 * survives repaints; the badge's own fill is cleared so only the circles show.
 */
function paintStack(document: Document, badge: HTMLElement, stack: readonly StackedPerson[], overflow: number): void {
  const circles: Circle[] = stack.map((person) => ({
    avatarUrl: person.avatarUrl, text: person.badge, color: person.color, ink: person.ink, ring: person.ring,
  }));
  if (overflow > 0) {
    circles.push({ avatarUrl: null, text: `+${overflow}`, color: "var(--muted, #e5e7eb)",
      ink: "var(--muted-foreground, #6b7280)", ring: "var(--sidebar-background, var(--background))" });
  }
  Object.assign(badge.style, { background: "transparent", color: "", width: "", padding: "0", overflow: "", boxShadow: "none" });
  const existing = [...badge.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.hasAttribute(STACK_ITEM_ATTRIBUTE));
  if (existing.length !== badge.childNodes.length) badge.replaceChildren(...existing);
  circles.forEach((circle, index) => {
    let item = existing[index];
    if (item === undefined) {
      item = createCircle(document);
      item.setAttribute(STACK_ITEM_ATTRIBUTE, "");
      badge.append(item);
    }
    item.style.marginLeft = index === 0 ? "" : "-4px";
    item.style.zIndex = String(circles.length - index);
    paintCircle(document, item, circle);
  });
  for (const stale of existing.slice(circles.length)) stale.remove();
}

function createCircle(document: Document): HTMLSpanElement {
  const circle = document.createElement("span");
  Object.assign(circle.style, {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: "0",
    position: "relative",
    minWidth: CIRCLE_SIZE,
    height: CIRCLE_SIZE,
    padding: "0 3px",
    borderRadius: "9999px",
    boxShadow: "0 0 0 1px var(--sidebar-background, var(--background))",
    color: "white",
    fontSize: "9px",
    fontWeight: "700",
    lineHeight: CIRCLE_SIZE,
    textAlign: "center",
    pointerEvents: "none",
  });
  return circle;
}

function nativeStatus(status: ThreadStatus): NativeThreadStatus {
  return { icon: status.icon, label: status.label, tone: status.tone };
}

function removeAllBadges(document: Document): void {
  for (const badge of document.querySelectorAll("[" + BADGE_ATTRIBUTE + "]")) badge.remove();
}
