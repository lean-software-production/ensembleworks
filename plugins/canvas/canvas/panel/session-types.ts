import type { Session } from "./shared.js";

export interface CanvasSessionProps {
  readonly session: Session;
  readonly subPath: string;
  readonly identities: Readonly<Record<string, string>>;
  readonly selfName: string | null;
}
