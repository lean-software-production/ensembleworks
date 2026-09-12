import { useState } from "react";
import { Room } from "livekit-client";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.js";

let room: Room | null = null;

function HuddleControl() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<"idle" | "joining" | "joined">("idle");
  const [muted, setMuted] = useState(false);
  const [camera, setCamera] = useState(false);
  const joinOrLeave = async () => {
    if (status === "joined") { await room?.disconnect(); room = null; setStatus("idle"); return; }
    setStatus("joining");
    try {
      const result = await rpc.call("huddle_token", {});
      if (!result.ok) { window.alert(result.detail); setStatus("idle"); return; }
      room = new Room();
      await room.connect(result.url, result.token);
      await room.localParticipant.setMicrophoneEnabled(true);
      setStatus("joined");
    } catch (cause) { window.alert(cause instanceof Error ? cause.message : String(cause)); setStatus("idle"); }
  };
  return <span style={{ display: "inline-flex", gap: 6 }}>
    <button type="button" onClick={() => void joinOrLeave()}>{status === "joining" ? "Joining…" : status === "joined" ? "Leave huddle" : "Join huddle"}</button>
    {status === "joined" && <button type="button" onClick={() => { const next = !muted; void room?.localParticipant.setMicrophoneEnabled(!next); setMuted(next); }}>{muted ? "Unmute" : "Mute"}</button>}
    {status === "joined" && <button type="button" onClick={() => { const next = !camera; void room?.localParticipant.setCameraEnabled(next); setCamera(next); }}>{camera ? "Camera off" : "Camera on"}</button>}
  </span>;
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({ id: "huddle", title: "Huddle", component: HuddleControl });
});
