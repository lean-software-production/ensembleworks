import { joinAudio, leaveAudio, setCameraEnabled, setMuted } from "../av-room.js";
import { canvasBus } from "../panel-bus.js";
import { avTokenFrom } from "./preferences.js";
import { shouldTryClientSide } from "./navigate.js";
import type { ContentScriptRpc } from "./rpc.js";

export interface DockControlOptions {
  readonly audioButton: HTMLButtonElement;
  readonly micButton: HTMLButtonElement;
  readonly cameraButton: HTMLButtonElement;
  readonly faces: HTMLElement;
  readonly rpc: ContentScriptRpc;
  readonly setStatus: (text: string) => void;
  readonly refreshRoster: () => Promise<void>;
  readonly apply: (event: { type: "pan" | "jump" }) => void;
  readonly jumpTo: (path: string) => void;
}
export function wireDockControls(options: DockControlOptions): void {
  options.audioButton.addEventListener("click", () => {
    if (canvasBus.snapshot().av.status === "live") {
      options.setStatus("");
      void leaveAudio();
      return;
    }
    options.setStatus("");
    const self = canvasBus.snapshot().roster.find((member) => member.isSelf);
    void joinAudio(async () =>
      avTokenFrom(await options.rpc.call("canvas_av_token", self === undefined ? {} : { clientId: self.clientId })),
    ).then((outcome) => {
      if (outcome.ok) {
        void options.refreshRoster();
        return;
      }
      options.setStatus(
        outcome.reason === "not_configured"
          ? `LiveKit not configured — ${outcome.detail}`
          : `Could not join audio: ${outcome.detail}`,
      );
    });
  });

  options.micButton.addEventListener("click", () => {
    void setMuted(!canvasBus.snapshot().av.muted);
  });
  options.cameraButton.addEventListener("click", () => {
    void setCameraEnabled(!canvasBus.snapshot().av.cameraOn);
  });

  options.faces.addEventListener("click", (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const face = target.closest<HTMLElement>("[data-canvas-dock-pan]");
    const clientId = face?.dataset.canvasDockPan;
    if (clientId === undefined || clientId === "") return;
    canvasBus.panTo(clientId);
    options.apply({ type: "pan" });
  });

  options.faces.addEventListener("click", (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest<HTMLAnchorElement>("a[data-canvas-dock-jump]");
    const path = link?.dataset.canvasDockJump;
    if (path === undefined || path === "") return;
    if (!shouldTryClientSide({
      button: event.button,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      defaultPrevented: event.defaultPrevented,
    })) return;
    event.preventDefault();
    options.apply({ type: "jump" });
    options.jumpTo(path);
  });
}
