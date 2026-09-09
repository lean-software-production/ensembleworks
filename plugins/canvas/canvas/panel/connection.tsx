import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { CanvasSession } from "./session.js";
import { useCanvasConnection } from "./connection-runtime.js";

export function CanvasPanel({ subPath }: PluginNavPanelProps) {
  const { session, error, connectionState, identities, selfName, agents, treeGestures } =
    useCanvasConnection({ subPath });
  return (
    <div className="relative flex h-full min-h-0 w-full flex-col">
      {error === null ? null : (
        <div
          role="alert"
          className="border-b border-border bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
        >
          {error}
        </div>
      )}
      {connectionState === "connected" ? null : (
        <div className="border-b border-border bg-card px-3 py-1.5 text-xs text-muted-foreground">
          {connectionState === "connecting"
            ? "Connecting to bb…"
            : "Connection lost — reconnecting…"}
        </div>
      )}
      {session === null ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Opening canvas…
        </div>
      ) : (
        <CanvasSession
          session={session}
          subPath={subPath}
          identities={identities}
          selfName={selfName}
          agentLinks={agents.agentLinks}
          pendingShapeId={agents.pendingShapeId}
          onRunNote={agents.runNote}
          onUnlinkNote={agents.unlinkNote}
          onAttachThread={agents.attachThread}
          loadThreadOptions={agents.loadThreadOptions}
          treeGesturePending={treeGestures.pending}
          onAddGoal={treeGestures.addGoal}
          onAddBlocker={treeGestures.addBlocker}
          onLaunchNode={agents.launchNode}
        />
      )}
    </div>
  );
}
