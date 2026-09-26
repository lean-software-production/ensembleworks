import { useRef, useState } from "react";

/** "Copy" that says what happened: copied, or refused so the caller shows the text to copy by hand. */
export function useCopy() {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  // Bumped by every copy and reset, so a clipboard write that settles late never reports over a newer one.
  const attempt = useRef(0);
  const copy = (text: string) => {
    const mine = ++attempt.current;
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(() => "copied" as const, () => "failed" as const)
      .then((next) => { if (mine === attempt.current) setState(next); });
  };
  const reset = () => {
    attempt.current += 1;
    setState("idle");
  };
  return { state, copy, reset };
}
