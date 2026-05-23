import * as path from "node:path";
import { Type } from "typebox";
const orchestrator = require("../src/index.js");

const ScriptIdsSchema = Type.Array(Type.String(), { description: "Named orchestrator script ids from .pi/orchestrator/config.json" });

const TaskSchema = Type.Object({
  id: Type.String({ description: "Stable task id, e.g. api, ui, tests" }),
  agent: Type.Optional(Type.String({ description: "Worker agent prompt to use. Default: worker" })),
  task: Type.String({ description: "Scoped implementation instructions for this worker" }),
  model: Type.Optional(Type.String({ description: "Optional model override for this worker" })),
  startupScripts: Type.Optional(ScriptIdsSchema),
  validationScripts: Type.Optional(ScriptIdsSchema),
});

const IntegrationScriptsSchema = Type.Object({
  startupScripts: Type.Optional(ScriptIdsSchema),
  validationScripts: Type.Optional(ScriptIdsSchema),
});

function textResult(text, details) {
  return { content: [{ type: "text", text }], details };
}

function errorResult(error) {
  const message = error && error.stack ? error.stack : String(error && error.message ? error.message : error);
  return { content: [{ type: "text", text: `Orchestrator error:\n${message}` }], isError: true, details: { error: message } };
}

function compactManifest(manifest) {
  return {
    runId: manifest.runId,
    status: manifest.status,
    baseBranch: manifest.baseBranch,
    baseCommit: manifest.baseCommit,
    tasks: (manifest.tasks || []).map((t) => ({
      id: t.id,
      status: t.status,
      branch: t.branch,
      worktree: t.worktree,
      commit: t.commit,
      error: t.error,
    })),
    integration: manifest.integration,
  };
}

function formatDispatchResult(manifest) {
  const lines = [`# Orchestrator Dispatch ${manifest.runId}`, "", `Status: ${manifest.status}`, "", "## Workers"];
  for (const task of manifest.tasks || []) {
    lines.push(`- ${task.id}: ${task.status}${task.commit ? ` @ ${String(task.commit).slice(0, 12)}` : ""}`);
    if (task.summary) lines.push(`  ${String(task.summary).split("\n")[0]}`);
    if (task.error) lines.push(`  Error: ${task.error}`);
  }
  lines.push("", `Manifest: .pi/orchestrator/runs/${manifest.runId}/manifest.json`);
  return lines.join("\n");
}

export default function piOrchestratorExtension(pi) {
  if (process.env.PI_ORCHESTRATOR_ROLE === "worker") return;

  const packageRoot = path.resolve(__dirname, "..");

  pi.on("resources_discover", async () => ({
    promptPaths: [path.join(packageRoot, "prompts")],
  }));

  pi.on("before_agent_start", async (event) => ({
    systemPrompt:
      event.systemPrompt +
      "\n\n# Pi Orchestrator Extension\n" +
      "When the user asks to orchestrate, split, delegate, use workers, use worktrees, merge worker results, or mentions /orchestrate, use the orchestrator tools. " +
      "Recommended flow: read specs, inspect .pi/orchestrator/config.json for named scripts, propose a task decomposition with explicit startupScripts/validationScripts per task and integration, ask for approval, call orchestrator_dispatch with worktreeMode per-task, then use orchestrator_status, orchestrator_verify, and orchestrator_merge as needed. " +
      "Do not auto-detect scripts; choose named scripts explicitly from config and show the effective selections to the user. For per-task worktrees, keep tasks scoped with clear file ownership. Do not use orchestrator tools inside worker processes.\n",
  }));

  pi.registerTool({
    name: "orchestrator_plan",
    label: "Orchestrator Plan",
    description: "Persist an approved orchestrator plan and task decomposition without dispatching workers yet.",
    promptSnippet: "Persist an orchestrator run plan and task decomposition",
    parameters: Type.Object({
      runName: Type.Optional(Type.String({ description: "Human-friendly run name" })),
      runId: Type.Optional(Type.String({ description: "Optional explicit run id" })),
      baseRef: Type.Optional(Type.String({ description: "Base git ref. Default: HEAD" })),
      worktreeMode: Type.Optional(Type.String({ description: "per-task, shared, or none. Default: per-task" })),
      summary: Type.Optional(Type.String({ description: "Plan summary" })),
      planMarkdown: Type.Optional(Type.String({ description: "Full Markdown plan to save as plan.md" })),
      integration: Type.Optional(IntegrationScriptsSchema),
      tasks: Type.Array(TaskSchema, { description: "Worker tasks" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const result = await orchestrator.createPlan(params, { cwd: ctx.cwd });
        return textResult(`Saved orchestrator plan ${result.manifest.runId}\nPlan: ${result.planPath}`, compactManifest(result.manifest));
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "orchestrator_dispatch",
    label: "Orchestrator Dispatch",
    description: "Create orchestrator worker worktrees, run startup hooks, dispatch workers, capture commits, and persist a manifest.",
    promptSnippet: "Dispatch parallel implementation workers, optionally in separate git worktrees",
    promptGuidelines: [
      "Use orchestrator_dispatch only after the user has approved the task decomposition for an orchestrated implementation.",
      "Set dryRun to true first when the user asks to preview branches, worktrees, hooks, or worker commands without modifying files.",
    ],
    parameters: Type.Object({
      runName: Type.Optional(Type.String({ description: "Human-friendly run name" })),
      runId: Type.Optional(Type.String({ description: "Optional explicit run id" })),
      baseRef: Type.Optional(Type.String({ description: "Base git ref. Default: HEAD" })),
      worktreeMode: Type.Optional(Type.String({ description: "per-task, shared, or none. Default: per-task" })),
      dryRun: Type.Optional(Type.Boolean({ description: "Preview without creating worktrees or modifying files" })),
      requireClean: Type.Optional(Type.Boolean({ description: "Require clean repo before per-task worktrees. Default: true" })),
      maxConcurrency: Type.Optional(Type.Number({ description: "Maximum workers to run concurrently" })),
      integration: Type.Optional(IntegrationScriptsSchema),
      tasks: Type.Array(TaskSchema, { description: "Worker tasks to run" }),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      try {
        onUpdate?.({ content: [{ type: "text", text: "Starting orchestrator dispatch..." }] });
        const result = await orchestrator.dispatch(params, { cwd: ctx.cwd, signal });
        if (result.dryRun) {
          return textResult(`Dry run for ${result.manifest.runId}:\n\n${JSON.stringify(compactManifest(result.manifest), null, 2)}`, result.manifest);
        }
        return textResult(formatDispatchResult(result.manifest), compactManifest(result.manifest));
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "orchestrator_status",
    label: "Orchestrator Status",
    description: "Show orchestrator run status or list recent runs.",
    promptSnippet: "Show orchestrator run status or list recent runs",
    parameters: Type.Object({ runId: Type.Optional(Type.String({ description: "Run id. Omit to list runs." })) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const result = await orchestrator.getStatus(params, { cwd: ctx.cwd });
        return textResult(result.summary, result.manifest ? compactManifest(result.manifest) : { runs: result.runs });
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "orchestrator_merge",
    label: "Orchestrator Merge",
    description: "Create/update the integration worktree and merge completed worker branches sequentially.",
    promptSnippet: "Merge completed worker branches into an integration worktree",
    parameters: Type.Object({
      runId: Type.String({ description: "Run id to integrate" }),
      baseRef: Type.Optional(Type.String({ description: "Optional integration base ref override" })),
      startupScripts: Type.Optional(ScriptIdsSchema),
      validationScripts: Type.Optional(ScriptIdsSchema),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const result = await orchestrator.mergeRun(params, { cwd: ctx.cwd });
        const integration = result.integration;
        const lines = [`Integration ${integration.status}: ${integration.branch}`, `Worktree: ${integration.worktree}`];
        if (result.conflict) lines.push(`Conflict while merging ${result.conflict.taskId}. Resolve in the integration worktree.`);
        return textResult(lines.join("\n"), compactManifest(result.manifest));
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "orchestrator_verify",
    label: "Orchestrator Verify",
    description: "Verify manifest, worktrees, branches, commits, dirty status, and optionally validation commands.",
    promptSnippet: "Verify an orchestrator run's manifest, worktrees, branches, commits, and validation",
    parameters: Type.Object({
      runId: Type.String({ description: "Run id to verify" }),
      runValidation: Type.Optional(Type.Boolean({ description: "Run configured validation commands during verification" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const result = await orchestrator.verifyRun(params, { cwd: ctx.cwd });
        const text = [`Verify ${result.ok ? "passed" : "failed"} for ${params.runId}`, "", ...result.checks.map((c) => `- ${c.ok ? "✓" : "✗"} ${c.name}: ${typeof c.details === "string" ? c.details : JSON.stringify(c.details)}`)].join("\n");
        return textResult(text, { ok: result.ok, checks: result.checks });
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "orchestrator_cleanup",
    label: "Orchestrator Cleanup",
    description: "Remove a run's worker and integration worktrees and mark the manifest cleaned.",
    promptSnippet: "Remove orchestrator worktrees for a run",
    parameters: Type.Object({
      runId: Type.String({ description: "Run id to clean up" }),
      force: Type.Optional(Type.Boolean({ description: "Force remove worktrees. Default: true" })),
      deleteManifest: Type.Optional(Type.Boolean({ description: "Also delete .pi/orchestrator/runs/<run-id>" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const result = await orchestrator.cleanupRun(params, { cwd: ctx.cwd });
        return textResult(`Cleaned ${result.removed.length} worktree(s) for ${params.runId}.`, result);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerCommand("orchestrate", {
    description: "Ask the agent to orchestrate a spec with task decomposition, worktrees, workers, and optional merge.",
    handler: async (args) => {
      pi.sendUserMessage(`Use the orchestrator extension for this request. Read the relevant specs, propose a task decomposition, ask for approval before dispatch, prefer per-task worktrees, and merge only after reporting results. Request: ${args || "(no request provided)"}`);
    },
  });

  pi.registerCommand("orch-status", {
    description: "Show orchestrator status. Usage: /orch-status [run-id]",
    handler: async (args, ctx) => {
      const result = await orchestrator.getStatus({ runId: args?.trim() || undefined }, { cwd: ctx.cwd });
      ctx.ui.notify(result.summary, "info");
    },
  });

  pi.registerCommand("orch-merge", {
    description: "Merge an orchestrator run into its integration worktree. Usage: /orch-merge <run-id>",
    handler: async (args, ctx) => {
      const runId = args?.trim();
      if (!runId) return ctx.ui.notify("Usage: /orch-merge <run-id>", "warning");
      const result = await orchestrator.mergeRun({ runId }, { cwd: ctx.cwd });
      ctx.ui.notify(`Integration ${result.integration.status}: ${result.integration.branch}`, result.conflict ? "warning" : "info");
    },
  });

  pi.registerCommand("orch-verify", {
    description: "Verify an orchestrator run. Usage: /orch-verify <run-id>",
    handler: async (args, ctx) => {
      const runId = args?.trim();
      if (!runId) return ctx.ui.notify("Usage: /orch-verify <run-id>", "warning");
      const result = await orchestrator.verifyRun({ runId }, { cwd: ctx.cwd });
      ctx.ui.notify(`Verify ${result.ok ? "passed" : "failed"}: ${runId}`, result.ok ? "info" : "warning");
    },
  });

  pi.registerCommand("orch-cleanup", {
    description: "Remove orchestrator worktrees. Usage: /orch-cleanup <run-id>",
    handler: async (args, ctx) => {
      const runId = args?.trim();
      if (!runId) return ctx.ui.notify("Usage: /orch-cleanup <run-id>", "warning");
      const result = await orchestrator.cleanupRun({ runId }, { cwd: ctx.cwd });
      ctx.ui.notify(`Cleaned ${result.removed.length} worktree(s): ${runId}`, "info");
    },
  });
};
