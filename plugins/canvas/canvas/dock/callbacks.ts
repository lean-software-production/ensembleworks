import type { ExpandEvent } from "./expand.js";

type RenderCallback = () => void;
type ApplyCallback = (event: ExpandEvent) => void;

export interface DockCallbackState {
  readonly render: RenderCallback;
  readonly apply: ApplyCallback;
  readonly setRender: (render: RenderCallback) => void;
  readonly setApply: (apply: ApplyCallback) => void;
}

export function createDockCallbacks(): DockCallbackState {
  let renderImplementation: RenderCallback | null = null;
  let applyImplementation: ApplyCallback | null = null;

  return {
    render: () => {
      const render = renderImplementation;
      if (render === null) throw new Error("dock render callback is not bound");
      render();
    },
    apply: (event) => {
      const apply = applyImplementation;
      if (apply === null) throw new Error("dock apply callback is not bound");
      apply(event);
    },
    setRender: (render) => {
      renderImplementation = render;
    },
    setApply: (apply) => {
      applyImplementation = apply;
    },
  };
}
