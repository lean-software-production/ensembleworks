/**
 * The row, the popover, and the keyboard contract between them.
 *
 * Imperative DOM rather than React: a content script is mounted outside every
 * React tree bb owns, and the row has to be a single node the placement code can
 * MOVE between anchors without ever producing a second one.
 *
 * Structure, and why it is this shape:
 *
 * - THE ROW IS ONE BUTTON. Everything inside it is a span, so there is no nested
 *   interactive content: one tab stop, one activation, and a screen reader reads
 *   one control rather than a thicket. Every action that needs its own control —
 *   choosing a room, opening Zoom, opening the conversation — lives in the
 *   popover, where controls can be siblings instead of children.
 * - THE POPOVER IS A DIALOG IN `<body>`. The sidebar clips and scrolls; a
 *   popover rendered inside it would be cut off by the first and dragged by the
 *   second. It is positioned in viewport coordinates, bounded in height, and
 *   scrolls its own list.
 * - FOCUS IS ACCOUNTED FOR. Opening moves focus into the dialog, Escape and the
 *   close button return it to the row, Tab cycles inside the dialog while it is
 *   open, and a click elsewhere dismisses it without stealing focus back from
 *   wherever the user just went.
 *
 * Rendering is incremental where focus could be destroyed by rebuilding: the
 * participant list is rebuilt freely (nothing in it is focusable), while the
 * room picker is only rebuilt when the set of rooms actually changes, so an open
 * dropdown is never yanked shut by a poll.
 */

import type { PopoverModel, RowModel } from "./model.js";
import { POPOVER_ID, ROW_ROOT_ID, STYLE_ID, presenceStyles } from "./styles.js";

export interface StripCallbacks {
  /** A human chose a different room inside the popover. */
  selectRoom(roomId: string): void;
  /** The still to draw for a face, if one has already been fetched. */
  portrait(participantId: string, capturedAt: number): string | null;
  /** Called when the popover opens or closes, so the controller can react. */
  openChanged?(open: boolean): void;
}

export interface Strip {
  readonly root: HTMLElement;
  readonly row: HTMLButtonElement;
  readonly popover: HTMLElement;
  renderRow(model: RowModel): void;
  renderPopover(model: PopoverModel): void;
  isOpen(): boolean;
  open(): void;
  close(options?: { restoreFocus?: boolean }): void;
  owns(node: Node | null): boolean;
  destroy(): void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  return node;
}

function face(
  doc: Document,
  input: { initials: string; label: string; speaking: boolean; portrait: string | null; hint: string | null },
): HTMLElement {
  const node = element(doc, "span", "ewzp-face");
  node.dataset.speaking = String(input.speaking);
  if (input.portrait) {
    const image = element(doc, "img");
    image.src = input.portrait;
    // A still is described as a still. The alternative — an <img> that reads as
    // a person's live camera — is the dishonest version of this feature.
    image.alt = input.hint ?? `Still image of ${input.label}`;
    node.append(image);
  } else {
    node.textContent = input.initials;
  }
  return node;
}

const FOCUSABLE = 'a[href], button:not([disabled]), select, [tabindex]:not([tabindex="-1"])';

export function createStrip(options: {
  document: Document;
  callbacks: StripCallbacks;
}): Strip {
  const doc = options.document;
  const style = element(doc, "style");
  style.id = STYLE_ID;
  style.textContent = presenceStyles();
  doc.head.append(style);

  const root = element(doc, "div");
  root.id = ROW_ROOT_ID;
  const row = element(doc, "button", "ewzp-row");
  row.type = "button";
  row.setAttribute("aria-haspopup", "dialog");
  row.setAttribute("aria-expanded", "false");
  row.setAttribute("aria-controls", POPOVER_ID);
  const dot = element(doc, "span", "ewzp-dot");
  dot.setAttribute("aria-hidden", "true");
  const name = element(doc, "span", "ewzp-name");
  const faces = element(doc, "span", "ewzp-faces");
  faces.setAttribute("aria-hidden", "true");
  const note = element(doc, "span", "ewzp-note");
  const count = element(doc, "span", "ewzp-count");
  const chevron = element(doc, "span", "ewzp-chevron");
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "⌃";
  row.append(dot, name, faces, note, count, chevron);
  root.append(row);

  const popover = element(doc, "div");
  popover.id = POPOVER_ID;
  popover.setAttribute("role", "dialog");
  popover.setAttribute("tabindex", "-1");
  popover.hidden = true;
  const header = element(doc, "div", "ewzp-pop-header");
  const popDot = element(doc, "span", "ewzp-dot");
  popDot.setAttribute("aria-hidden", "true");
  const title = element(doc, "span", "ewzp-pop-title");
  const close = element(doc, "button", "ewzp-close");
  close.type = "button";
  close.setAttribute("aria-label", "Close room details");
  close.textContent = "×";
  header.append(popDot, title, close);
  const status = element(doc, "p", "ewzp-status");
  const picker = element(doc, "div", "ewzp-room-picker");
  const pickerLabel = element(doc, "span");
  pickerLabel.textContent = "Room";
  const select = element(doc, "select");
  select.setAttribute("aria-label", "Room shown in the sidebar");
  picker.append(pickerLabel, select);
  picker.hidden = true;
  const people = element(doc, "ul", "ewzp-people");
  const empty = element(doc, "p", "ewzp-empty");
  const actions = element(doc, "div", "ewzp-actions");
  const join = element(doc, "a", "ewzp-join");
  // A real link: the saved room URL, opened the way the user's own Zoom client
  // preference says. BB never joins a meeting itself, and there is no Meeting
  // SDK anywhere in this plugin.
  join.target = "_blank";
  join.rel = "noopener noreferrer";
  join.textContent = "Open Zoom room";
  const transcript = element(doc, "a", "ewzp-transcript");
  transcript.textContent = "Conversation";
  actions.append(join, transcript);
  const footnote = element(doc, "p", "ewzp-footnote");
  popover.append(header, status, picker, people, empty, actions, footnote);
  doc.body.append(popover);

  let open = false;
  let renderedRooms = "";

  const setOpen = (next: boolean, restoreFocus: boolean): void => {
    if (open === next) return;
    open = next;
    popover.hidden = !next;
    row.setAttribute("aria-expanded", String(next));
    if (next) {
      // Focus lands on the close button, so the first thing Escape-averse
      // keyboard users meet is the way out, and Tab then walks the dialog.
      close.focus();
    } else if (restoreFocus) {
      row.focus();
    }
    options.callbacks.openChanged?.(next);
  };

  row.addEventListener("click", () => setOpen(!open, false));
  close.addEventListener("click", () => setOpen(false, true));
  select.addEventListener("change", () => {
    if (select.value) options.callbacks.selectRoom(select.value);
  });
  popover.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      setOpen(false, true);
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(popover.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (node) => !node.hasAttribute("hidden") && node.getAttribute("aria-disabled") !== "true",
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    const active = doc.activeElement;
    if (event.shiftKey && (active === first || active === popover)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });
  row.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      setOpen(false, true);
    }
  });

  return {
    root,
    row,
    popover,
    isOpen: () => open,
    open: () => setOpen(true, false),
    close: (closeOptions) => setOpen(false, closeOptions?.restoreFocus ?? false),
    owns: (node) => node !== null && (root.contains(node) || popover.contains(node)),
    renderRow(model) {
      root.dataset.tier = model.tier;
      dot.dataset.state = model.dot;
      name.textContent = model.showName ? model.roomName : "";
      name.hidden = !model.showName;
      row.setAttribute("aria-label", model.ariaLabel);
      faces.replaceChildren(
        ...model.faces.map((item) =>
          face(doc, {
            initials: item.initials,
            label: item.label,
            speaking: item.speaking,
            portrait: item.portraitAt === null
              ? null
              : options.callbacks.portrait(item.id, item.portraitAt),
            hint: null,
          })),
      );
      // The rail has no faces, so it has nothing to add to: it carries a bare
      // count instead of a "+N" chip.
      if (model.overflow > 0 && model.tier !== "rail") {
        const more = element(doc, "span", "ewzp-face ewzp-more");
        more.textContent = `+${model.overflow}`;
        faces.append(more);
      }
      faces.hidden = model.faces.length === 0 && model.overflow === 0;
      // The collapsed rail has no room for faces, so it carries the bare count
      // instead — and no "+", because with nothing beside it there is nothing
      // to add to.
      const railCount = model.tier === "rail" && model.count > 0;
      count.textContent = railCount ? String(model.count) : "";
      count.hidden = !railCount;
      const showNote = model.note !== null && model.faces.length === 0 && !railCount;
      note.textContent = showNote ? model.note : "";
      note.hidden = !showNote;
      chevron.hidden = model.tier === "rail";
    },
    renderPopover(model) {
      title.textContent = model.title;
      popover.setAttribute("aria-label", `${model.title} — room presence`);
      popDot.dataset.state = model.dot;
      status.textContent = model.status;
      const signature = model.rooms.map((item) => `${item.id}:${item.name}`).join("|");
      if (signature !== renderedRooms) {
        renderedRooms = signature;
        select.replaceChildren(
          ...model.rooms.map((item) => {
            const option = element(doc, "option");
            option.value = item.id;
            option.textContent = item.name;
            return option;
          }),
        );
      }
      if (model.selectedRoomId !== null) select.value = model.selectedRoomId;
      // One room is not a choice; showing a picker for it is noise.
      picker.hidden = model.rooms.length < 2;
      people.replaceChildren(
        ...model.people.map((person) => {
          const item = element(doc, "li", "ewzp-person");
          item.append(face(doc, {
            initials: person.initials,
            label: person.label,
            speaking: person.speaking,
            portrait: person.portraitAt === null
              ? null
              : options.callbacks.portrait(person.id, person.portraitAt),
            hint: person.portraitHint,
          }));
          const label = element(doc, "span", "ewzp-person-name");
          label.textContent = person.label;
          const state = element(doc, "span", "ewzp-person-status");
          state.dataset.speaking = String(person.speaking);
          state.textContent = person.status;
          item.append(label, state);
          return item;
        }),
      );
      people.setAttribute("aria-label", `People seen in ${model.title}`);
      people.hidden = model.people.length === 0;
      empty.textContent = model.emptyMessage ?? "";
      empty.hidden = model.emptyMessage === null;
      if (model.joinUrl && model.joinable) {
        join.href = model.joinUrl;
        join.removeAttribute("aria-disabled");
      } else {
        join.removeAttribute("href");
        join.setAttribute("aria-disabled", "true");
      }
      join.setAttribute("aria-label", `Open the ${model.title} Zoom room in a new tab`);
      if (model.conversationHref) {
        transcript.href = model.conversationHref;
        transcript.hidden = false;
        transcript.setAttribute(
          "aria-label",
          model.conversationLabel
            ? `Open the current conversation, ${model.conversationLabel}`
            : "Open the current conversation",
        );
      } else {
        transcript.removeAttribute("href");
        transcript.hidden = true;
      }
      footnote.textContent = model.joinNote ?? model.portraitNote ?? "";
      footnote.hidden = footnote.textContent === "";
    },
    destroy() {
      setOpen(false, false);
      root.remove();
      popover.remove();
      style.remove();
    },
  };
}
