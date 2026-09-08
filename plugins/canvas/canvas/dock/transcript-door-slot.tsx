// The invisible half of the transcript button: a React component whose only job
// is to stand inside bb's thread-route provider tree and hand its
// `openThreadPanel` to the imperative strip.
//
// It renders NOTHING. The visible control is the "Transcript" button in the
// presence strip's popover (canvas/dock/dock.ts), because that is where the
// room already lives and because the strip is on every route while this
// component is on none but a thread's. Drawing a second button here would be
// two doors an inch apart — and bb's header row, where this slot renders, is
// exactly the space the popover was chosen to stop competing for.
//
// WHY THIS SLOT AND NOT THE ALWAYS-MOUNTED ONE. `experimental_sidebarAccessory`
// (canvas/roster-ui.tsx's `CanvasOnlineCount`) is mounted in every bb window,
// which makes it the obvious relay — and it is the wrong side of the tree.
// Walking `__reactFiber$` ancestor chains on the running app found the
// `openThreadPanel` provider above the page-header row and above the actions
// cluster, and absent from the sidebar accessory's entire 92-fiber chain, so
// the hook would simply return false there. `experimental_threadHeaderAction`
// renders into the header's action row — the same cluster the strip is
// prepended into — which is provably inside the provider.
//
// See canvas/dock/transcript-door.ts for the singleton, the measurements, and
// the two limits (thread routes only; last-writer-wins in a split).
import { useEffect } from "react";
import { useBbNavigate, type PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { transcriptDoor } from "./transcript-door.js";

/** The `threadPanelAction` id this door opens — the same registration the panel
 * launcher row and the quick-palette command already point at. */
const TRANSCRIPT_ACTION = "transcript";

export function TranscriptDoorSlot(_props: PluginThreadHeaderActionProps): null {
  const navigate = useBbNavigate();

  useEffect(() => {
    return transcriptDoor.setOpener(() => {
      const accepted = navigate.openThreadPanel({
        actionId: TRANSCRIPT_ACTION,
        title: "Room transcript",
      });
      // THE ONE LINK IN THE CHAIN THAT WAS PROVED STRUCTURALLY AND NOT
      // EXECUTED. The provider was shown to be an ancestor of this slot's row
      // by fiber walk; that it actually returns true was not observed until
      // this code ran. Logged rather than assumed, so the answer is readable in
      // the console of any window that clicks the button.
      console.info(
        `[canvas] openThreadPanel(${TRANSCRIPT_ACTION}) returned ${String(accepted)}`,
      );
      return accepted;
    });
  }, [navigate]);

  return null;
}
