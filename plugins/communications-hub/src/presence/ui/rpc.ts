/**
 * An rpc client for code that is not a React component.
 *
 * `@get-bb/plugin-sdk/app`'s `useRpc()` is a hook: the host resolves the plugin
 * id from a React context it provides inside its own slot trees. A content
 * script has no such tree — it is imperative code the host mounts once per
 * frontend generation with `{ pluginId, generation, signal }` and nothing else —
 * so the hook is unreachable from the sidebar strip.
 *
 * What IS reachable is the wire the hook speaks, and it is documented rather
 * than reverse-engineered: `PluginRpcClient.call`'s own contract in
 * bb-plugin-sdk-app.d.ts names the endpoint —
 *
 *     Invoke one of the plugin's `bb.rpc` methods
 *     (POST /api/v1/plugins/<id>/rpc/<method>)
 *
 * — and the content-script contract hands us the `<id>` half. Same origin, same
 * session, same server-side validation and the same "local" auth semantics the
 * panel gets; the only thing not shared with the hook is React. That matters for
 * portraits in particular: an image is fetched through this authenticated
 * surface, never through the plugin's one unauthenticated route (the
 * signature-verified Zoom webhook), which serves no presence data at all.
 */

interface RpcEnvelope {
  readonly ok?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

export interface ContentScriptRpc {
  call(method: string, input: unknown): Promise<unknown>;
}

export function createContentScriptRpc(
  pluginId: string,
  fetchImpl: typeof fetch = fetch,
): ContentScriptRpc {
  return {
    async call(method, input) {
      const url = `/api/v1/plugins/${encodeURIComponent(pluginId)}/rpc/${encodeURIComponent(method)}`;
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The input IS the body, undefined normalised to null — the shape the
        // host's own client sends, so a handler cannot tell the two apart.
        body: JSON.stringify(input ?? null),
      });
      const body: RpcEnvelope | null = await response
        .json()
        .then((value: unknown) => (isEnvelope(value) ? value : null))
        .catch(() => null);
      if (!response.ok || body?.ok !== true) {
        throw new Error(errorMessage(body, method, response.status));
      }
      return body.result;
    },
  };
}

function isEnvelope(value: unknown): value is RpcEnvelope {
  return typeof value === "object" && value !== null;
}

/** The most specific thing we can honestly say went wrong, method included. */
function errorMessage(body: RpcEnvelope | null, method: string, status: number): string {
  const error = body?.error;
  if (typeof error === "object" && error !== null) {
    const message = Reflect.get(error, "message");
    if (typeof message === "string" && message.length > 0) return message;
  }
  if (typeof error === "string" && error.length > 0) return error;
  return `rpc "${method}" failed (HTTP ${status})`;
}
