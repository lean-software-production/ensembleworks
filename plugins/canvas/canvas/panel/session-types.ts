import type { Session } from "./shared.js";
import type { RpcClient } from "./connection-types.js";

export interface CanvasSessionProps {
  readonly session: Session;
  readonly subPath: string;
  readonly identities: Readonly<Record<string, string>>;
  readonly selfName: string | null;
  readonly rpc: RpcClient;
}
