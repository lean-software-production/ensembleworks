type NativeThreadStatus = {
  icon: string;
  label: string;
  tone?: "default" | "error" | "running" | "success";
};

export type ThreadStatus = NativeThreadStatus & {
  viewers: number;
  typing: number;
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
    const existing = [...anchor.children].find((child) => child.hasAttribute(BADGE_ATTRIBUTE));
    const row = anchor.closest<HTMLElement>("[data-parent-card]") ?? anchor.parentElement ?? anchor;
    const nativeRendered = status ? hasNativeStatus(row, status.label) : false;

    if (!status || nativeRendered) {
      existing?.remove();
      continue;
    }

    const badge = existing instanceof HTMLElement ? existing : createBadge(document);
    const count = String(status.viewers);
    if (badge.textContent !== count) badge.textContent = count;
    badge.setAttribute("aria-label", status.label);
    badge.setAttribute("title", status.label);
    badge.style.background = status.typing > 0
      ? "var(--warning, #f59e0b)"
      : "var(--success, #22c55e)";
    if (!existing) anchor.append(badge);
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
    left: "-7px",
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
  for (const badge of document.querySelectorAll("[" + BADGE_ATTRIBUTE + "]")) badge.remove();
}
