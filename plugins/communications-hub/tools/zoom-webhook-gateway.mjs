#!/usr/bin/env node
/**
 * Path-restricted gateway for Zoom RTMS webhooks.
 *
 * docs/zoom-setup.md requires publishing exactly one BB route publicly:
 *   POST /api/v1/plugins/<plugin-id>/http/zoom/webhook
 *
 * This process listens on a local port, forwards only that exact path to the
 * BB server, and rejects everything else. Put a tunnel (cloudflared, Tailscale
 * Funnel, or a reverse proxy) in front of this port, never in front of BB.
 *
 * Request body bytes are forwarded unmodified, along with the Zoom signature
 * headers, because the adapter verifies the signature over the raw body.
 *
 * Usage:
 *   node tools/zoom-webhook-gateway.mjs [--port 8787] [--plugin-id communications-hub]
 *                                       [--target http://127.0.0.1:38886]
 */
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const port = Number(flag("port", process.env.ZOOM_GATEWAY_PORT ?? 8787));
const pluginId = flag("plugin-id", process.env.ZOOM_GATEWAY_PLUGIN_ID ?? "communications-hub");
const target = new URL(flag("target", process.env.BB_SERVER_URL ?? "http://127.0.0.1:38886"));
const allowedPath = `/api/v1/plugins/${pluginId}/http/zoom/webhook`;
const MAX_BODY_BYTES = 64 * 1024;

const forward = target.protocol === "https:" ? httpsRequest : httpRequest;

/** Access log. Never logs the body or the Zoom signature headers. */
function log(method, path, status) {
  console.log(`${new Date().toISOString()} ${method} ${path} -> ${status}`);
}

function reject(response, status, message, method = "?", path = "?") {
  log(method, path, status);
  response.writeHead(status, { "content-type": "text/plain;charset=UTF-8" });
  response.end(message);
}

const server = createServer((incoming, response) => {
  const path = (incoming.url ?? "").split("?")[0];
  const method = incoming.method ?? "?";
  if (path !== allowedPath) return reject(response, 404, "Not found", method, path);
  if (method !== "POST") return reject(response, 405, "Method not allowed", method, path);

  const chunks = [];
  let size = 0;
  let aborted = false;
  incoming.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      aborted = true;
      reject(response, 413, "Payload too large", method, path);
      incoming.destroy();
      return;
    }
    chunks.push(chunk);
  });
  incoming.on("end", () => {
    if (aborted) return;
    const body = Buffer.concat(chunks);
    const headers = { "content-length": String(body.length) };
    for (const name of ["content-type", "x-zm-request-timestamp", "x-zm-signature"]) {
      const value = incoming.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const upstream = forward(
      { protocol: target.protocol, hostname: target.hostname, port: target.port, path: allowedPath, method: "POST", headers },
      (upstreamResponse) => {
        log(method, path, upstreamResponse.statusCode ?? 502);
        response.writeHead(upstreamResponse.statusCode ?? 502, {
          "content-type": upstreamResponse.headers["content-type"] ?? "text/plain;charset=UTF-8",
        });
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", () => reject(response, 502, "Upstream unavailable", method, path));
    upstream.end(body);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`zoom-webhook-gateway listening on http://127.0.0.1:${port}`);
  console.log(`forwarding only POST ${allowedPath} to ${target.origin}`);
});
