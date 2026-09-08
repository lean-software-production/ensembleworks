// Composition root for the always-mounted canvas presence dock.
//
// ux-contract: none — behavior-preserving module extraction in plugins/canvas; no interaction contract changed. No RED interaction contract is applicable because no behavior is added or fixed.
import type {
  PluginContentScriptContext,
  PluginContentScriptDisposer,
} from "@get-bb/plugin-sdk/app";
import { createContentScriptRpc } from "./rpc.js";
import { forgetRetiredPreferences } from "./preferences.js";
import { createDockDom } from "./dom.js";
import { createDockRoute } from "./route.js";
import { createDockRows } from "./rows.js";
import { createDockPlacement, initialDockSqueeze } from "./placement.js";
import { createDockView } from "./view.js";
import { createDockInteractions } from "./interactions.js";
import { wireDockControls } from "./controls.js";
import { createDockSubscriptions } from "./subscriptions.js";
import { createDockRepaint } from "./repaint.js";
import { createDockCallbacks } from "./callbacks.js";
import {
  disposeDockLifecycle,
  type DockLifecycleResources,
} from "./lifecycle.js";

export function mountAvDock(
  context: PluginContentScriptContext,
): PluginContentScriptDisposer {
  const fetchForContext: typeof fetch = (input, init) => {
    return fetch(input, {
      ...init,
      signal: context.signal,
    });
  };
  const rpc = createContentScriptRpc(
    context.pluginId,
    fetchForContext,
  );
  forgetRetiredPreferences();

  let disposed = false;
  let selfIdentity: string | null = null;
  const callbacks = createDockCallbacks();
  const route = createDockRoute({
    rpc,
    isDisposed: () => disposed,
    selfIdentity: () => selfIdentity,
    render: callbacks.render,
    onLocation: () => {},
  });
  const initialSqueeze = initialDockSqueeze();
  const dom = createDockDom(initialSqueeze);
  const root = dom.root;
  const popover = dom.popover;
  const rows = createDockRows({
    root,
    roster: route.roster,
    selfIdentity: () => selfIdentity,
    isDisposed: () => disposed,
    clearHostStatus: context.experimental_setThreadRowStatus,
  });
  const placement = createDockPlacement({
    root,
    popover,
    route,
    rows,
    initialSqueeze,
    isDisposed: () => disposed,
    render: callbacks.render,
    apply: callbacks.apply,
  });
  const repaint = createDockRepaint({
    render: callbacks.render,
  });
  const view = createDockView({
    dom,
    route,
    rows,
    selfIdentity: () => selfIdentity,
    squeeze: placement.tier,
    repaint,
    placePopover: placement.syncPopover,
  });
  callbacks.setRender(view.render);
  callbacks.setApply(view.apply);
  const interactions = createDockInteractions({
    dom,
    apply: view.apply,
    setStatus: view.setStatus,
    insideWidget: placement.insideWidget,
  });
  wireDockControls({
    audioButton: dom.audioButton,
    micButton: dom.micButton,
    cameraButton: dom.cameraButton,
    faces: dom.faces,
    rpc,
    setStatus: view.setStatus,
    refreshRoster: route.refresh,
    apply: view.apply,
    jumpTo: route.jumpTo,
  });
  const subscriptions = createDockSubscriptions({
    repaint,
    signal: context.signal,
    route,
    isDisposed: () => disposed,
    render: view.render,
    schedule: placement.schedule,
    poll: placement.poll,
    setIdentity: (name) => {
      selfIdentity = name;
    },
  });
  const resources: DockLifecycleResources = {
    dom,
    rows,
    placement,
    interactions,
    subscriptions,
    view,
  };

  rows.retire();
  placement.syncAnchor();
  placement.syncSqueeze();
  route.check();
  view.render();
  void route.refresh();

  return () => {
    disposed = true;
    disposeDockLifecycle(resources);
  };
}
