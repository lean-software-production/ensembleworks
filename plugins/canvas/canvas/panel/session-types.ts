import type { CanvasAgentLink } from "../wire.js";
import type { ThreadOption } from "../thread-picker.js";
import type { Session } from "./shared.js";

export interface CanvasSessionProps {
  readonly session: Session;
  readonly subPath: string;
  readonly identities: Readonly<Record<string, string>>;
  readonly selfName: string | null;
  readonly agentLinks: Readonly<Record<string, CanvasAgentLink>>;
  readonly pendingShapeId: string | null;
  readonly onRunNote: (shapeId: string, text: string) => void;
  readonly onUnlinkNote: (shapeId: string) => void;
  readonly onAttachThread: (shapeId: string, threadId: string) => void;
  readonly loadThreadOptions: () => Promise<ThreadOption[]>;
  readonly treeGesturePending: "goal" | "blocker" | null;
  readonly onAddGoal: (treeId: string, title: string) => void;
  readonly onAddBlocker: (parentId: string, title: string) => void;
}
