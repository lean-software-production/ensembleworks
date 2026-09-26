import { useState } from "react";

/** "Copy" that says what happened: copied, or refused so the caller shows the text to copy by hand. */
export function useCopy() {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = (text: string) => {
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(() => setState("copied"), () => setState("failed"));
  };
  return { state, copy };
}
