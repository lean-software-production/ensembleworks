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
};

export type ThreadStatusSetter = (threadId: string, status: NativeThreadStatus | null) => void;

const BADGE_ATTRIBUTE = "data-bb-presence-badge";
const TINT_ATTRIBUTE = "data-bb-ownership-tint";

/**
 * The row tint: a colour bar down the row's leading edge in the badge's colour.
 *
 * This is the at-a-glance half of the ownership UI — "whose thread is this" answered
 * without reading anything, per-person hues coming from `personColor`. The badge still
 * carries the initials for "who exactly". An inset box-shadow is used rather than a
 * border so the row's own layout is untouched.
 */
function tintRow(row: HTMLElement, color: string): void {
  row.setAttribute(TINT_ATTRIBUTE, "");
  row.style.boxShadow = `inset 2px 0 0 0 ${color}`;
}

function untintRow(row: HTMLElement): void {
  row.removeAttribute(TINT_ATTRIBUTE);
  row.style.boxShadow = "";
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
  const tinted = new Set<Element>();
  for (const anchor of document.querySelectorAll<HTMLElement>("[data-sidebar-thread-id]")) {
    const threadId = anchor.getAttribute("data-sidebar-thread-id");
    const status = threadId === null ? undefined : currentStatuses.get(threadId);
    const existing = [...anchor.children].find((child) => child.hasAttribute(BADGE_ATTRIBUTE));
    const row = anchor.closest<HTMLElement>("[data-parent-card]") ?? anchor.parentElement ?? anchor;
    const nativeRendered = status ? hasNativeStatus(row, status.label) : false;

    if (!status) {
      existing?.remove();
      continue;
    }

    // The tint is ours either way: it is a colour the native row status has no slot for,
    // so it is painted even when bb renders the glyph itself.
    tintRow(row, status.badgeColor);
    tinted.add(row);

    if (nativeRendered) {
      existing?.remove();
      continue;
    }

    const badge = existing instanceof HTMLElement ? existing : createBadge(document);
    if (badge.textContent !== status.badge) badge.textContent = status.badge;
    badge.setAttribute("aria-label", status.label);
    badge.setAttribute("title", status.label);
    badge.style.background = status.badgeColor;
    if (!existing) anchor.append(badge);
    liveBadges.add(badge);
  }

  for (const badge of document.querySelectorAll("[" + BADGE_ATTRIBUTE + "]")) {
    if (!liveBadges.has(badge)) badge.remove();
  }
  for (const row of document.querySelectorAll<HTMLElement>("[" + TINT_ATTRIBUTE + "]")) {
    if (!tinted.has(row)) untintRow(row);
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
    // INSIDE the row, not hanging off it. The original -7px suited presence's 6px dot;
    // an ownership badge carries initials, and half of it was clipped by the window edge.
    left: "2px",
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
  for (const row of document.querySelectorAll<HTMLElement>("[" + TINT_ATTRIBUTE + "]")) untintRow(row);
  for (const badge of document.querySelectorAll("[" + BADGE_ATTRIBUTE + "]")) badge.remove();
}
