import * as fs from "node:fs/promises";
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

function configPathFor(cwd) {
  return path.join(cwd, ".pi", "orchestrator", "config.json");
}

function defaultConfigFor(cwd) {
  return {
    worktrees: {
      root: `../${path.basename(cwd)}-orch-worktrees`,
    },
    scripts: {},
    defaults: {
      workerStartupScripts: [],
      workerValidationScripts: [],
      integrationStartupScripts: [],
      integrationValidationScripts: [],
    },
  };
}

async function readOrchestratorConfig(cwd) {
  const file = configPathFor(cwd);
  try {
    return { file, exists: true, config: JSON.parse(await fs.readFile(file, "utf8")) };
  } catch (error) {
    if (error && error.code === "ENOENT") return { file, exists: false, config: defaultConfigFor(cwd) };
    throw error;
  }
}

async function writeOrchestratorConfig(cwd, config) {
  const file = configPathFor(cwd);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(config, null, 2) + "\n", "utf8");
  return file;
}

function validateOrchestratorConfig(config) {
  const errors = [];
  const warnings = [];
  const scripts = config?.scripts && typeof config.scripts === "object" && !Array.isArray(config.scripts) ? config.scripts : {};
  if (!config || typeof config !== "object") errors.push("Config must be a JSON object.");
  if (!config?.worktrees?.root) warnings.push("worktrees.root is not set; the default worktree root will be used.");
  for (const [id, script] of Object.entries(scripts)) {
    if (!script || typeof script !== "object") errors.push(`scripts.${id} must be an object.`);
    else if (typeof script.command !== "string" || !script.command.trim()) errors.push(`scripts.${id}.command is required.`);
  }
  const defaults = config?.defaults || {};
  for (const key of ["workerStartupScripts", "workerValidationScripts", "integrationStartupScripts", "integrationValidationScripts"]) {
    const ids = defaults[key] || [];
    if (!Array.isArray(ids)) {
      errors.push(`defaults.${key} must be an array of script ids.`);
      continue;
    }
    for (const id of ids) if (!scripts[id]) errors.push(`defaults.${key} references unknown script id: ${id}`);
  }
  return { ok: errors.length === 0, errors, warnings, scriptIds: Object.keys(scripts).sort() };
}

async function chooseScriptIds(ctx, config, title, current = []) {
  const ids = Object.keys(config.scripts || {}).sort();
  if (ids.length === 0) {
    ctx.ui.notify("No scripts defined yet. Add scripts before setting defaults.", "warning");
    return current;
  }
  const raw = await ctx.ui.input(`${title}\nAvailable: ${ids.join(", ")}\nComma-separated script ids:`, current.join(", "));
  if (raw === undefined) return current;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

async function handleOrchestratorConfigCommand(args, ctx) {
  const actionArg = args?.trim();
  const action = actionArg || (ctx.hasUI
    ? await ctx.ui.select("Orchestrator config", ["show", "validate", "init", "add-script", "set-defaults"])
    : "show");
  if (!action) return;

  const loaded = await readOrchestratorConfig(ctx.cwd);
  const config = loaded.config;

  if (action === "show") {
    ctx.ui.notify(`${loaded.file}\n\n${JSON.stringify(config, null, 2)}`, "info");
    return;
  }

  if (action === "validate") {
    const validation = validateOrchestratorConfig(config);
    const lines = [validation.ok ? "Config is valid." : "Config has errors."];
    if (validation.scriptIds.length) lines.push(`Scripts: ${validation.scriptIds.join(", ")}`);
    for (const warning of validation.warnings) lines.push(`Warning: ${warning}`);
    for (const error of validation.errors) lines.push(`Error: ${error}`);
    ctx.ui.notify(lines.join("\n"), validation.ok ? "info" : "warning");
    return;
  }

  if (action === "init") {
    if (loaded.exists && ctx.hasUI) {
      const ok = await ctx.ui.confirm("Overwrite orchestrator config?", `${loaded.file} already exists. Overwrite it with a default named-script config?`);
      if (!ok) return;
    }
    const file = await writeOrchestratorConfig(ctx.cwd, defaultConfigFor(ctx.cwd));
    ctx.ui.notify(`Created ${file}`, "info");
    return;
  }

  if (action === "add-script") {
    if (!ctx.hasUI) return ctx.ui.notify("add-script requires interactive UI.", "warning");
    const id = await ctx.ui.input("Script id, e.g. frontend:setup");
    if (!id) return;
    const command = await ctx.ui.input(`Command for ${id}`);
    if (!command) return;
    const cwd = await ctx.ui.input("cwd relative to worktree root (blank for root)", "");
    const timeoutRaw = await ctx.ui.input("timeoutSeconds (blank for none)", "");
    const required = await ctx.ui.confirm("Required script?", "If required, failure blocks the current phase.");
    config.scripts = config.scripts || {};
    config.scripts[id] = {
      command,
      ...(cwd?.trim() ? { cwd: cwd.trim() } : {}),
      ...(timeoutRaw?.trim() ? { timeoutSeconds: Number(timeoutRaw.trim()) } : {}),
      required,
    };
    const file = await writeOrchestratorConfig(ctx.cwd, config);
    ctx.ui.notify(`Added script ${id} to ${file}`, "info");
    return;
  }

  if (action === "set-defaults") {
    if (!ctx.hasUI) return ctx.ui.notify("set-defaults requires interactive UI.", "warning");
    config.defaults = config.defaults || {};
    config.defaults.workerStartupScripts = await chooseScriptIds(ctx, config, "Default worker startup scripts", config.defaults.workerStartupScripts || []);
    config.defaults.workerValidationScripts = await chooseScriptIds(ctx, config, "Default worker validation scripts", config.defaults.workerValidationScripts || []);
    config.defaults.integrationStartupScripts = await chooseScriptIds(ctx, config, "Default integration startup scripts", config.defaults.integrationStartupScripts || []);
    config.defaults.integrationValidationScripts = await chooseScriptIds(ctx, config, "Default integration validation scripts", config.defaults.integrationValidationScripts || []);
    const validation = validateOrchestratorConfig(config);
    if (!validation.ok) {
      ctx.ui.notify(`Defaults not saved; config would be invalid:\n${validation.errors.join("\n")}`, "warning");
      return;
    }
    const file = await writeOrchestratorConfig(ctx.cwd, config);
    ctx.ui.notify(`Updated defaults in ${file}`, "info");
    return;
  }

  ctx.ui.notify("Usage: /orch-config [show|validate|init|add-script|set-defaults]", "warning");
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

  pi.registerCommand("orch-config", {
    description: "Create, show, validate, or edit .pi/orchestrator/config.json. Usage: /orch-config [show|validate|init|add-script|set-defaults]",
    handler: handleOrchestratorConfigCommand,
  });

  pi.registerCommand("orchestrator-config", {
    description: "Alias for /orch-config.",
    handler: handleOrchestratorConfigCommand,
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
