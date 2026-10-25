import { describe, expect, it, vi } from "vitest";
import { FabroClient, FabroHttpError } from "./fabro";

function response(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("FabroClient", () => {
  it('fetches the real graph and bounded stage statuses with server authentication', async () => {
    const fetch = vi.fn(async (url: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) => String(url).includes('/graph')
      ? new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } })
      : response({ data: [{ node_id: 'plan', name: 'plan', status: 'running', visit: 1 }], meta: { has_more: false } }));
    const graph = await new FabroClient({ fetch, token: 'test-token' }).graph('run-1');
    expect(graph.svg).toBe('<svg/>');
    expect(graph.stages[0]?.status).toBe('running');
    expect(graph.stagesComplete).toBe(true);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer test-token');
  });
  it("registers an immutable workflow and returns its content address", async () => {
    const fetch = vi.fn(async () => response({ workflow_version_id: "a".repeat(64) }));
    const client = new FabroClient({ fetch });
    await expect(client.registerWorkflow({ entrypoint: "workflow.fabro", files: { "workflow.fabro": "digraph X {}" }, workflow_dependencies: {} })).resolves.toBe("a".repeat(64));
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/workflow-versions"), expect.objectContaining({ method: "POST" }));
  });

  it("falls back to the legacy RunManifest lane when workflow versions are unavailable", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ error: "not found" }, 404))
      .mockResolvedValueOnce(response({ id: "run-legacy" }));
    const client = new FabroClient({ fetch });
    const version = { entrypoint: "workflow.fabro", files: { "workflow.fabro": "digraph X {}" }, workflow_dependencies: {} };
    const id = await client.registerWorkflow(version);
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    await client.createRun({ workflow_version_id: id, target: { kind: "folder", path: "/tmp/worktree" }, args: { labels: { bb_job_id: "job" } }, goal: "refactor" });
    const request = fetch.mock.calls[1]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.version).toBe(1);
    expect(body.cwd).toBe("/tmp/worktree");
    expect(body.workflows["workflow.fabro"].source).toBe("digraph X {}");
    expect(body.args.label).toEqual(["bb_job_id=job"]);
  });

  it("reports pagination completion from the API metadata", async () => {
    const fetch = vi.fn(async () => response({ data: [{ id: "r1" }], meta: { has_more: true } }));
    const page = await new FabroClient({ fetch }).listRunsPage({ bb_job_id: "job" });
    expect(page.complete).toBe(false);
    expect(page.runs).toHaveLength(0);
  });

  it("does not retain or expose an unauthorized response body", async () => {
    const fetch = vi.fn(async () => response({ error: "token fabro_dev_secret" }, 401));
    try { await new FabroClient({ fetch }).listRuns(); expect.unreachable(); } catch (error) {
      expect(error).toBeInstanceOf(FabroHttpError);
      expect((error as FabroHttpError).body).toBeUndefined();
      expect(String(error)).not.toContain("secret");
    }
  });

  it("propagates caller cancellation", async () => {
    const controller = new AbortController();
    const fetch = vi.fn((_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const pending = new FabroClient({ fetch, signal: controller.signal, timeoutMs: 60_000 }).listRuns();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("bounds a large response before decoding the entire body", async () => {
    const fetch = vi.fn(async () => response("x".repeat(10_000), 200, { "content-length": "10000" }));
    await expect(new FabroClient({ fetch, maxResponseBytes: 100 }).listRuns()).rejects.toThrow("exceeded 100 bytes");
  });

  it("rejects a successful non-JSON response", async () => {
    const fetch = vi.fn(async () => response("truncated {", 200));
    await expect(new FabroClient({ fetch }).listRuns()).rejects.toThrow("not valid JSON");
  });
});
