import type { MutableRefObject } from "react";
import type { PluginRpcClient, PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { BbTransport } from "../../transport.js";
import type { rpcContract } from "../../server";
import type { Session } from "./shared.js";

export type RpcClient = PluginRpcClient<typeof rpcContract>;

export type ConnectionProps = Pick<PluginNavPanelProps, "subPath">;

export interface ConnectionRuntime {
  readonly clientId: string;
  readonly rpcRef: MutableRefObject<RpcClient>;
  readonly subPathRef: MutableRefObject<string>;
  readonly session: Session | null;
  readonly sessionRef: MutableRefObject<Session | null>;
  readonly transportRef: MutableRefObject<BbTransport | null>;
  readonly selfName: string | null;
  readonly identities: Record<string, string>;
  readonly error: string | null;
  readonly setError: (error: string | null) => void;
  readonly setSession: (session: Session | null) => void;
  readonly setSelfName: (name: string | null) => void;
  readonly setIdentities: (identities: Record<string, string>) => void;
  readonly rpc: RpcClient;
}

export type RpcContract = typeof rpcContract;
