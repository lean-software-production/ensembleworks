/**
 * Attractor server entry point (task T4).
 *
 * Wires the DOT front-end (T2), execution engine (T3) and BB-thread backend
 * (server/backend.ts) into BB: storage, the `attractor_run`/`attractor_inspect`/
 * `attractor_result` agent tools, `bb attractor …` CLI, the RPC surface, and a
 * background service that resumes `running` runs on plugin (re)start.
 */

import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract } from "./host-contract";
import { createThreadAgentBackend } from "./server/backend";
import { createThreadHumanInterviewer } from "./server/human";
import { rpcContract } from "./server/contracts";
import { createService, resolveWorkflowPath } from "./server/service";
import { RUN_MIGRATIONS, RunStore } from "./server/store";

const id = z.string().min(1).max(200);

// A plugin agent tool's `parameters` schema is turned into a JSON Schema for
// the provider; `z.json()` is defined recursively (a JSON value can contain
// JSON values) and the SDK refuses a tool whose parameters contain a
// recursive local $ref chain (see "BB plugin SDK notes" — "some model
// providers reject the complete tool list when any one tool contains them").
// So `inputs`/`context_updates` are bounded to flat scalar maps here, not
// arbitrary JSON — see README "Deviations from the plan".
const scalarValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const runInputSchema = z
  .object({
    source: z.string().min(1).max(200_000).optional(),
    path: z.string().min(1).max(2000).optional(),
    inputs: z.record(z.string(), scalarValueSchema).optional(),
    title: z.string().max(200).optional(),
  })
  .refine((v) => (v.source !== undefined) !== (v.path !== undefined), { message: "exactly one of source or path must be given" });

const inspectInputSchema = z.object({ runId: id }).strict();

const routingResultSchema = z.object({
  outcome: z.enum(["succeeded", "failed", "partially_succeeded"]),
  preferred_next_label: z.string().optional(),
  suggested_next_ids: z.array(z.string()).optional(),
  failure_reason: z.string().optional(),
  context_updates: z.record(z.string(), scalarValueSchema).optional(),
});

const TOOL_INSTRUCTIONS =
  "Attractor runs a Graphviz DOT workflow graph as a BB-thread-backed pipeline. attractor_run validates the graph, persists a run, and starts it in the background — emit the returned previewDirective exactly once, on its own line. attractor_inspect reads a run's status and stages.";

function textResult(value: unknown): PluginAgentToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "Attractor operation failed";
}

function decodeFileContent(file: { content: string; contentEncoding: "utf8" | "base64" }): string {
  return file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
}

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const db = bb.storage.database();
  bb.storage.migrate(db, [...RUN_MIGRATIONS]);
  const store = new RunStore(db);

  const agentBackend = createThreadAgentBackend(bb);
  const humanInterviewer = createThreadHumanInterviewer(bb);
  const execClient = bb.hosts.experimental_client({ contract: hostContract });
  const lifecycle = new AbortController();
  bb.onDispose(() => lifecycle.abort());

  const service = createService({ bb, store, agentBackend, execClient, humanInterviewer });

  async function resolveSource(input: { source?: string; path?: string }, threadId: string): Promise<string> {
    if (input.source !== undefined) return input.source;
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) throw new Error("attractor_run must be called from a thread attached to an environment to resolve a relative path");
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    if (!environment.path || !environment.hostId) throw new Error("the thread's environment is not ready");
    const resolvedPath = resolveWorkflowPath(input.path!, environment.path);
    const file = await bb.sdk.files.read({ hostId: environment.hostId, path: resolvedPath });
    if ("notModified" in file) throw new Error(`could not read workflow file: ${input.path}`);
    return decodeFileContent(file);
  }

  async function runWorkflow(input: z.infer<typeof runInputSchema>, threadId: string, projectId: string) {
    const source = await resolveSource(input, threadId);
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) throw new Error("attractor_run must be called from a thread attached to an environment");
    const { run, directive } = await service.createAndStartRun({
      source,
      threadId,
      projectId,
      environmentId: thread.environmentId,
      title: input.title,
      inputs: input.inputs as Record<string, never> | undefined,
    });
    return { runId: run.id, previewDirective: directive };
  }

  // A run's threadId is checked against the caller's own threadId on every
  // read (RPC, attractor_inspect, and every CLI subcommand that takes a
  // runId) so one thread can never read — or, for `stop`, mutate — another
  // thread's run, the same ownership rule the sibling bb-plugin-assembly-lines
  // applies to its jobs. Defined once and reused everywhere a runId crosses a
  // thread boundary, rather than only at the RPC surface.
  function owned(runId: string, threadId: string) {
    const { run, stages } = service.getRun(runId);
    if (!run || run.threadId !== threadId) return { run: null, stages: [] };
    return { run, stages };
  }

  function inspectRun(runId: string, threadId: string) {
    const { run, stages } = owned(runId, threadId);
    if (!run) throw new Error(`no such run: ${runId}`);
    return { run, stages };
  }

  bb.rpc.register(rpcContract, {
    getRun: ({ runId, threadId }) => rpcContract.getRun.output.parse(owned(runId, threadId)),
    listRuns: ({ threadId, after }) => rpcContract.listRuns.output.parse(service.listRuns({ threadId, after })),
    getGraph: ({ runId, threadId }) => rpcContract.getGraph.output.parse(owned(runId, threadId).run ? service.getGraph(runId) : null),
    getEvents: ({ runId, threadId, sinceSeq }) => rpcContract.getEvents.output.parse({ events: owned(runId, threadId).run ? service.getEvents(runId, sinceSeq) : [] }),
    stopRun: ({ runId, threadId }) => {
      if (!owned(runId, threadId).run) return { stopped: false };
      service.stopRun(runId);
      return { stopped: true };
    },
  });

  bb.agents.registerTool({
    name: "attractor_run",
    description: "Validate and run a Graphviz DOT Attractor workflow (inline source or a path in this thread's environment), returning a live thread-card directive.",
    instructions: TOOL_INSTRUCTIONS,
    parameters: runInputSchema,
    execute: async (input, ctx) => textResult(await runWorkflow(input, ctx.threadId, ctx.projectId)),
  });
  bb.agents.registerTool({
    name: "attractor_inspect",
    description: "Read an Attractor run's status and per-stage state.",
    instructions: TOOL_INSTRUCTIONS,
    parameters: inspectInputSchema,
    execute: async ({ runId }, ctx) => textResult(inspectRun(runId, ctx.threadId)),
  });
  bb.agents.registerTool({
    name: "attractor_result",
    description: "Report an Attractor workflow stage's structured routing result. Call this exactly once, when the node's prompt asks for it.",
    instructions: "Only call this when instructed to by the stage prompt. Report the JSON routing result described there.",
    parameters: routingResultSchema,
    execute: async (input, ctx) => {
      agentBackend.reportResult(ctx.threadId, input);
      return textResult({ recorded: true });
    },
  });

  bb.agents.configure((context) => {
    if (agentBackend.isWorkerThread(context.thread.id)) {
      return { tools: agentBackend.isAwaitingResult(context.thread.id) ? ["attractor_result"] : [], skills: [] };
    }
    return { tools: ["attractor_run", "attractor_inspect"], skills: ["attractor"] };
  });

  const usage =
    "bb attractor validate <path> | run <path> [--input k=v ...] [--title t] | status <runId> | stages <runId> | events <runId> [--since seq] | stop <runId> | answer <runId> <label|text>\nRun within the originating BB thread.";

  function parseInputFlags(argv: string[]): { inputs: Record<string, string>; rest: string[] } {
    const inputs: Record<string, string> = {};
    const rest: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--input" && argv[i + 1] !== undefined) {
        const [key, ...valueParts] = argv[i + 1].split("=");
        inputs[key] = valueParts.join("=");
        i += 1;
      } else if (argv[i] === "--title" && argv[i + 1] !== undefined) {
        rest.push("--title", argv[i + 1]);
        i += 1;
      } else if (argv[i] === "--since" && argv[i + 1] !== undefined) {
        rest.push("--since", argv[i + 1]);
        i += 1;
      } else {
        rest.push(argv[i]);
      }
    }
    return { inputs, rest };
  }

  bb.cli.register({
    name: "attractor",
    summary: "Run and inspect Attractor DOT workflows",
    commands: [
      { name: "validate", summary: "Validate a workflow file", usage: "bb attractor validate <path>" },
      { name: "run", summary: "Run a workflow file", usage: "bb attractor run <path> [--input k=v] [--title t]" },
      { name: "status", summary: "Show a run's status", usage: "bb attractor status <runId>" },
      { name: "stages", summary: "List a run's stages", usage: "bb attractor stages <runId>" },
      { name: "events", summary: "List a run's events", usage: "bb attractor events <runId> [--since seq]" },
      { name: "stop", summary: "Stop a running run", usage: "bb attractor stop <runId>" },
      { name: "answer", summary: "Answer a run's blocked human gate", usage: "bb attractor answer <runId> <label|text>" },
    ],
    async run(argv, ctx) {
      try {
        if (!argv.length || argv[0] === "--help") return { exitCode: 0, stdout: usage };
        if (!ctx.threadId) throw new Error("Run this command from a BB thread");
        const [command, ...args] = argv;
        const { inputs, rest } = parseInputFlags(args);
        let result: unknown;
        if (command === "validate" && rest[0]) {
          const source = await resolveSource({ path: rest[0] }, ctx.threadId);
          const { parseWorkflowGraph } = await import("./dot/graph");
          const { validate } = await import("./dot/validate");
          result = { diagnostics: validate(parseWorkflowGraph(source)) };
        } else if (command === "run" && rest[0]) {
          const titleIndex = rest.indexOf("--title");
          const title = titleIndex >= 0 ? rest[titleIndex + 1] : undefined;
          result = await runWorkflow({ path: rest[0], inputs, title }, ctx.threadId, ctx.projectId ?? "");
        } else if (command === "status" && rest[0]) {
          result = owned(rest[0], ctx.threadId).run;
        } else if (command === "stages" && rest[0]) {
          result = owned(rest[0], ctx.threadId).stages;
        } else if (command === "events" && rest[0]) {
          const sinceIndex = rest.indexOf("--since");
          const sinceSeq = sinceIndex >= 0 ? Number(rest[sinceIndex + 1]) : undefined;
          result = owned(rest[0], ctx.threadId).run ? service.getEvents(rest[0], sinceSeq) : [];
        } else if (command === "stop" && rest[0]) {
          if (!owned(rest[0], ctx.threadId).run) throw new Error(`no such run: ${rest[0]}`);
          result = service.stopRun(rest[0]);
        } else if (command === "answer" && rest[0] && rest.length > 1) {
          if (!owned(rest[0], ctx.threadId).run) throw new Error(`no such run: ${rest[0]}`);
          result = await service.answerHumanGate(rest[0], rest.slice(1).join(" "));
        } else {
          throw new Error(usage);
        }
        return { exitCode: 0, stdout: JSON.stringify(result) };
      } catch (error) {
        return { exitCode: 1, stderr: safeError(error) };
      }
    },
  });

  bb.background.service("attractor-runs", {
    async start(signal) {
      signal.addEventListener("abort", () => lifecycle.abort(), { once: true });
      await service.resumeRunningRuns();
    },
  });
}
