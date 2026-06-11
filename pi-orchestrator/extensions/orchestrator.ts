import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type } from "typebox";
const orchestrator = require("../src/index.js");

const multitask = orchestrator.multitask || require("../src/multitask/index.js");
const multitaskTui = multitask.tuiState || require("../src/multitask/tui-state.js");
const multitaskDashboard = multitask.dashboardServer || require("../src/multitask/dashboard-server.js");

const multitaskWidgetKey = "pi-multitask";
let multitaskWidgetTimer;
let tuiKit;

function getTuiKit() {
  if (!tuiKit) tuiKit = require("@mariozechner/pi-tui");
  return tuiKit;
}

const globalDaemonKey = "__piOrchestratorMultitaskDaemons";
const daemonRegistry = globalThis[globalDaemonKey] || new Map();
globalThis[globalDaemonKey] = daemonRegistry;

const ScriptIdsSchema = Type.Array(Type.String(), { description: "Named script ids from .pi/multitask/config.json" });

const MultitaskTaskSchema = Type.Object({
  id: Type.String({ description: "Stable task id, e.g. api, ui, tests" }),
  title: Type.Optional(Type.String({ description: "Optional human-friendly task title" })),
  prompt: Type.String({ description: "Scoped worker prompt/instructions" }),
  agent: Type.Optional(Type.String({ description: "Worker agent prompt to use. Default: worker" })),
  model: Type.Optional(Type.String({ description: "Optional model override for this worker" })),
  startupScripts: Type.Optional(ScriptIdsSchema),
  validationScripts: Type.Optional(ScriptIdsSchema),
  dependencies: Type.Optional(Type.Array(Type.String({ description: "Task ids that must finish before this task starts" }))),
});

const IntegrationScriptsSchema = Type.Object({
  startupScripts: Type.Optional(ScriptIdsSchema),
  validationScripts: Type.Optional(ScriptIdsSchema),
});

const MessageModeSchema = Type.Union([Type.Literal("steer"), Type.Literal("followUp")]);
const MessageTypeSchema = Type.Union([
  Type.Literal("assignment"),
  Type.Literal("question"),
  Type.Literal("inform"),
  Type.Literal("review_feedback"),
  Type.Literal("decision"),
]);

function textResult(text, details = {}) {
  return { content: [{ type: "text", text }], details };
}

function isFuturePhaseError(error) {
  const message = String(error?.message || error || "");
  return message.includes("protocol placeholder") || message.includes("later phase") || message.includes("future phase");
}

function futurePhaseResult(operation, error) {
  const message = String(error?.message || error || `${operation} is not implemented yet.`);
  return textResult(
    `${operation} is reserved for a later Porchestrator phase.\n\n${message}`,
    { placeholder: true, operation, message },
  );
}

function errorResult(error) {
  const message = error && error.stack ? error.stack : String(error && error.message ? error.message : error);
  return { content: [{ type: "text", text: `Porchestrator error:\n${message}` }], isError: true, details: { error: message } };
}

function compactMultitaskManifest(manifest) {
  if (!manifest) return undefined;
  return {
    runId: manifest.runId,
    runName: manifest.runName,
    status: manifest.status,
    baseRef: manifest.baseRef,
    baseBranch: manifest.baseBranch,
    baseCommit: manifest.baseCommit,
    worktreeRoot: manifest.worktreeRoot,
    tasks: (manifest.tasks || []).map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      branch: task.branch,
      worktree: task.worktree,
      worker: task.worker,
      error: task.error,
    })),
    integration: manifest.integration
      ? {
          status: manifest.integration.status,
          branch: manifest.integration.branch,
          worktree: manifest.integration.worktree,
          error: manifest.integration.error,
        }
      : undefined,
  };
}

function formatRunStatus(manifest) {
  if (!manifest) return "No multitask run loaded.";
  const lines = [`${manifest.runId}: ${manifest.status}`];
  for (const task of manifest.tasks || []) {
    const worker = task.worker?.activityStatus ? ` · worker ${task.worker.activityStatus}` : "";
    lines.push(`- ${task.id}: ${task.status}${worker}`);
    if (task.worktree) lines.push(`  worktree: ${task.worktree}`);
    if (task.branch) lines.push(`  branch: ${task.branch}`);
    if (task.error) lines.push(`  error: ${task.error}`);
  }
  if (manifest.integration) {
    lines.push(`- integration: ${manifest.integration.status}`);
    if (manifest.integration.worktree) lines.push(`  worktree: ${manifest.integration.worktree}`);
    if (manifest.integration.branch) lines.push(`  branch: ${manifest.integration.branch}`);
  }
  return lines.join("\n");
}

function formatStartResult(result) {
  const manifest = result.manifest;
  const lines = [
    `# Porchestrator ${manifest.runId}`,
    "",
    `Status: ${manifest.status}`,
    `Plan: ${result.planPath}`,
    `State: .pi/multitask/runs/${manifest.runId}/manifest.json`,
    "",
    "Workers are starting in the background. Continue chatting while they run.",
    "",
    "## Workers",
  ];
  for (const task of manifest.tasks || []) {
    lines.push(`- ${task.id}: ${task.status}`);
    if (task.worktree) lines.push(`  worktree: ${task.worktree}`);
    if (task.branch) lines.push(`  branch: ${task.branch}`);
  }
  return lines.join("\n");
}

function formatCommandResult(result, fallback = "Done.") {
  if (!result) return fallback;
  if (typeof result.summary === "string") return result.summary;
  if (result.manifest) return formatRunStatus(result.manifest);
  if (result.runId && result.taskId && result.command) return `Sent ${result.command} to ${result.runId}/${result.taskId}.`;
  return JSON.stringify(result, null, 2);
}

async function ensureMultitaskClient(cwd) {
  const repo = await orchestrator.getRepoInfo(cwd);
  const repoRoot = repo.root;
  const client = multitask.client.createClient({ cwd, repoRoot });

  try {
    await client.ping();
    return client;
  } catch (error) {
    const known = daemonRegistry.get(repoRoot);
    if (known) {
      await known.stop().catch(() => {});
      daemonRegistry.delete(repoRoot);
    }
  }

  const daemon = multitask.daemon.createDaemon({ cwd, repoRoot });
  await daemon.start();
  daemonRegistry.set(repoRoot, daemon);
  await client.ping();
  return client;
}

async function loadMultitaskTuiStateForCwd(cwd, options = {}) {
  const repo = await orchestrator.getRepoInfo(cwd);
  return multitaskTui.loadTuiState(repo.root, options);
}

async function refreshMultitaskWidget(ctx) {
  if (!ctx?.hasUI || !ctx.ui || typeof ctx.ui.setWidget !== "function") return undefined;
  try {
    const state = await loadMultitaskTuiStateForCwd(ctx.cwd, { eventLimit: 0 });
    const lines = multitaskTui.formatCompactWidgetLines(state, { maxRuns: 2, maxTasksPerRun: 4, width: 120 });
    const status = multitaskTui.formatStatusIndicator(state);
    ctx.ui.setWidget(multitaskWidgetKey, lines.length ? lines : undefined);
    if (typeof ctx.ui.setStatus === "function") {
      const themedStatus = status && ctx.ui.theme
        ? `${ctx.ui.theme.fg("accent", "mt")}${ctx.ui.theme.fg("dim", status.slice(2))}`
        : status;
      ctx.ui.setStatus(multitaskWidgetKey, themedStatus);
    }
    return state;
  } catch {
    ctx.ui.setWidget(multitaskWidgetKey, undefined);
    if (typeof ctx.ui.setStatus === "function") ctx.ui.setStatus(multitaskWidgetKey, undefined);
    return undefined;
  }
}

function scheduleMultitaskWidgetTimer(ctx) {
  if (multitaskWidgetTimer) clearInterval(multitaskWidgetTimer);
  multitaskWidgetTimer = setInterval(async () => {
    const state = await refreshMultitaskWidget(ctx).catch(() => undefined);
    if (!state?.activeRuns?.length) stopMultitaskWidgetRefresh(ctx);
  }, 15_000);
  if (typeof multitaskWidgetTimer.unref === "function") multitaskWidgetTimer.unref();
}

function startMultitaskWidgetRefresh(ctx) {
  if (!ctx?.hasUI) return;
  if (multitaskWidgetTimer) clearInterval(multitaskWidgetTimer);
  multitaskWidgetTimer = undefined;
  refreshMultitaskWidget(ctx)
    .then((state) => {
      if (state?.activeRuns?.length) scheduleMultitaskWidgetTimer(ctx);
    })
    .catch(() => {});
}

function stopMultitaskWidgetRefresh(ctx) {
  if (multitaskWidgetTimer) clearInterval(multitaskWidgetTimer);
  multitaskWidgetTimer = undefined;
  if (ctx?.hasUI && ctx.ui) {
    if (typeof ctx.ui.setWidget === "function") ctx.ui.setWidget(multitaskWidgetKey, undefined);
    if (typeof ctx.ui.setStatus === "function") ctx.ui.setStatus(multitaskWidgetKey, undefined);
  }
}

async function executeMultitask(ctx, operation, fn) {
  try {
    const client = await ensureMultitaskClient(ctx.cwd);
    const result = await fn(client);
    startMultitaskWidgetRefresh(ctx);
    return result;
  } catch (error) {
    if (isFuturePhaseError(error)) return futurePhaseResult(operation, error);
    return errorResult(error);
  }
}

async function notifyMultitaskCommand(ctx, operation, fn) {
  const result = await executeMultitask(ctx, operation, fn);
  const text = result.content?.map((entry) => entry.text).join("\n") || formatCommandResult(result.details);
  ctx.ui.notify(text, result.isError ? "warning" : "info");
}

function parseDashboardArgs(args) {
  const parts = parseTaskIds(args || "");
  const open = parts.includes("--open");
  const cleaned = parts.filter((part) => part !== "--open");
  return { commandOrRunId: cleaned[0], open };
}

function dashboardOutput(url, reused = false) {
  return [
    `Porchestrator dashboard ${reused ? "reused" : "running"}:`,
    url,
    "",
    "Bound to localhost only. Keep this URL private.",
  ].join("\n");
}

async function handleMultitaskDashboardCommand(args, ctx) {
  const { commandOrRunId, open } = parseDashboardArgs(args);
  try {
    const repo = await orchestrator.getRepoInfo(ctx.cwd);
    if (commandOrRunId === "stop") {
      const result = await multitaskDashboard.stopDashboardServer({ cwd: ctx.cwd, repoRoot: repo.root });
      return ctx.ui.notify(result.stopped ? "Stopped Porchestrator dashboard." : "Porchestrator dashboard is not running for this repo.", "info");
    }
    if (commandOrRunId === "status") {
      const status = await multitaskDashboard.getDashboardServerStatus({ cwd: ctx.cwd, repoRoot: repo.root });
      return ctx.ui.notify(status.running ? dashboardOutput(status.redactedUrl, true) : "Porchestrator dashboard is not running for this repo.", "info");
    }

    await ensureMultitaskClient(ctx.cwd);
    let defaultRunId = commandOrRunId;
    if (!defaultRunId) {
      const client = multitask.client.createClient({ cwd: ctx.cwd, repoRoot: repo.root });
      const status = await client.status({}).catch(() => undefined);
      defaultRunId = status?.activeRunId || status?.runs?.find((run) => !["merged", "failed", "aborted"].includes(run.status))?.runId || status?.runs?.[0]?.runId;
    }
    const result = await multitaskDashboard.startDashboardServer({ cwd: ctx.cwd, repoRoot: repo.root, defaultRunId });
    if (open) multitaskDashboard.openDashboardUrl(result.url);
    ctx.ui.notify(dashboardOutput(result.url, result.reused), "info");
  } catch (error) {
    ctx.ui.notify(`Unable to start Porchestrator dashboard: ${error.message || error}`, "warning");
  }
}

function configPathFor(cwd) {
  return path.join(cwd, ".pi", "multitask", "config.json");
}

function defaultConfigFor(cwd) {
  return {
    worktrees: {
      root: `../${path.basename(cwd)}-multitask-worktrees`,
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

async function readMultitaskConfig(cwd) {
  const file = configPathFor(cwd);
  try {
    return { file, exists: true, config: JSON.parse(await fs.readFile(file, "utf8")) };
  } catch (error) {
    if (error && error.code === "ENOENT") return { file, exists: false, config: defaultConfigFor(cwd) };
    throw error;
  }
}

async function writeMultitaskConfig(cwd, config) {
  const file = configPathFor(cwd);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(config, null, 2) + "\n", "utf8");
  return file;
}

function validateMultitaskConfig(config) {
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

async function handleMultitaskConfigCommand(args, ctx) {
  const actionArg = args?.trim();
  const action = actionArg || (ctx.hasUI
    ? await ctx.ui.select("Porchestrator named-script config", ["show", "validate", "init", "add-script", "set-defaults"])
    : "show");
  if (!action) return;

  const loaded = await readMultitaskConfig(ctx.cwd);
  const config = loaded.config;

  if (action === "show") {
    ctx.ui.notify(`${loaded.file}\n\n${JSON.stringify(config, null, 2)}`, "info");
    return;
  }

  if (action === "validate") {
    const validation = validateMultitaskConfig(config);
    const lines = [validation.ok ? "Config is valid." : "Config has errors."];
    if (validation.scriptIds.length) lines.push(`Scripts: ${validation.scriptIds.join(", ")}`);
    for (const warning of validation.warnings) lines.push(`Warning: ${warning}`);
    for (const error of validation.errors) lines.push(`Error: ${error}`);
    ctx.ui.notify(lines.join("\n"), validation.ok ? "info" : "warning");
    return;
  }

  if (action === "init") {
    if (loaded.exists && ctx.hasUI) {
      const ok = await ctx.ui.confirm("Overwrite multitask script config?", `${loaded.file} already exists. Overwrite it with a default named-script config?`);
      if (!ok) return;
    }
    const file = await writeMultitaskConfig(ctx.cwd, defaultConfigFor(ctx.cwd));
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
    const file = await writeMultitaskConfig(ctx.cwd, config);
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
    const validation = validateMultitaskConfig(config);
    if (!validation.ok) {
      ctx.ui.notify(`Defaults not saved; config would be invalid:\n${validation.errors.join("\n")}`, "warning");
      return;
    }
    const file = await writeMultitaskConfig(ctx.cwd, config);
    ctx.ui.notify(`Updated defaults in ${file}`, "info");
    return;
  }

  ctx.ui.notify("Usage: /mt-config [show|validate|init|add-script|set-defaults]", "warning");
}

function multitaskRequestText(args) {
  return [
    "Use Porchestrator mode for this request.",
    "Inspect relevant files/specs first, then propose independent local-worktree workers and explicit named startupScripts/validationScripts selections from .pi/multitask/config.json (do not auto-detect scripts).",
    "Ask for approval before calling multitask_start. After starting, keep helping while workers run and use multitask_status/diff/message to monitor or steer. Review and merge/apply only after user approval.",
    `Request: ${args?.trim() || "(no request provided)"}`,
  ].join("\n");
}

function splitCommandArgs(args, maxParts) {
  const parts = String(args || "").trim().split(/\s+/).filter(Boolean);
  if (!maxParts || parts.length <= maxParts) return parts;
  return [...parts.slice(0, maxParts - 1), parts.slice(maxParts - 1).join(" ")];
}

function parseTaskIds(args) {
  return String(args || "").trim().split(/\s+/).filter(Boolean);
}

function buildPanelItems(state) {
  const runs = state.activeRuns.length ? state.activeRuns : state.runs;
  const items = [];
  for (const run of runs) {
    for (const task of run.tasks || []) items.push({ run, task, key: `${run.runId}/${task.id}` });
  }
  return items;
}

function truncatePanelLine(line, width) {
  try {
    return getTuiKit().truncateToWidth(String(line), width);
  } catch {
    return multitaskTui.truncatePlain(line, width);
  }
}

function matchesPanelKey(data, keyName) {
  const { matchesKey, Key } = getTuiKit();
  const key = Key?.[keyName] || keyName;
  return matchesKey(data, key);
}

const panelViewLabels = {
  board: "task board",
  runs: "runs",
  detail: "task detail",
  transcript: "transcript tail",
  diff: "diff summary",
  review: "review results",
  integration: "integration",
};

class MultitaskPanelComponent {
  constructor(state, options = {}) {
    this.state = state;
    this.theme = options.theme;
    this.done = options.done || (() => {});
    this.requestRender = options.requestRender || (() => {});
    this.items = buildPanelItems(state);
    this.selectedIndex = Math.max(0, Math.min(options.selectedIndex || 0, Math.max(0, this.items.length - 1)));
    this.view = options.view || "board";
    this.closed = false;
  }

  invalidate() {}

  selected() {
    return this.items[this.selectedIndex];
  }

  selectedRun() {
    return this.selected()?.run || this.state.runs?.find((run) => run.runId === this.state.activeRunId) || this.state.runs?.[0];
  }

  selectedKey() {
    const selected = this.selected();
    return selected ? selected.key : undefined;
  }

  move(delta) {
    if (!this.items.length) return;
    this.selectedIndex = Math.max(0, Math.min(this.items.length - 1, this.selectedIndex + delta));
    this.requestRender();
  }

  setView(view) {
    this.view = view;
    this.requestRender();
  }

  finish(action, extra = {}) {
    if (this.closed) return;
    this.closed = true;
    const selected = this.selected();
    const run = selected?.run || this.selectedRun();
    this.done({
      action,
      runId: run?.runId,
      taskId: selected?.task?.id,
      selectedIndex: this.selectedIndex,
      view: this.view,
      ...extra,
    });
  }

  handleInput(data) {
    if (matchesPanelKey(data, "up")) return this.move(-1);
    if (matchesPanelKey(data, "down")) return this.move(1);
    if (matchesPanelKey(data, "escape")) {
      if (this.view !== "board") {
        this.setView("board");
        return;
      }
      return this.finish("close");
    }
    if (matchesPanelKey(data, "enter") || data === "i") return this.setView("detail");
    if (data === "q") return this.finish("close");
    if (data === "b") return this.setView("board");
    if (data === "l") return this.setView("runs");
    if (data === "t") return this.setView("transcript");
    if (data === "d") return this.setView("diff");
    if (data === "v") return this.setView("review");
    if (data === "g") return this.setView("integration");
    if (data === "u") return this.finish("refresh");
    if (data === "m") return this.finish("message", { mode: "followUp" });
    if (data === "s") return this.finish("message", { mode: "steer" });
    if (data === "x") return this.finish("cancel");
    if (data === "e") return this.finish("resume");
    if (data === "R") return this.finish("review");
    if (data === "D") return this.finish("diff");
    if (data === "M") return this.finish("mergeSelected");
    if (data === "a") return this.finish("applyIntegration");
    if (data === "c") return this.finish("cleanup");
  }

  renderViewLines() {
    const selected = this.selected();
    const run = selected?.run || this.selectedRun();
    if (this.view === "runs") {
      return multitaskTui.formatRunsListLines(this.state, { selectedRunId: run?.runId });
    }
    if (!selected && !run) return ["No Porchestrator runs found."];
    if (!selected && !["runs", "integration"].includes(this.view)) return ["No multitask tasks found for this run."];
    if (this.view === "detail") return multitaskTui.formatTaskDetail(selected.task, selected.run);
    if (this.view === "transcript") return multitaskTui.formatTranscriptTailLines(selected.task, { maxEntries: 20, maxWidth: 140 });
    if (this.view === "diff") return multitaskTui.formatDiffSummaryLines(selected.task, { maxFiles: 20 });
    if (this.view === "review") return multitaskTui.formatReviewResultsLines(selected.task, { maxChecks: 12 });
    if (this.view === "integration") return multitaskTui.formatIntegrationStatusLines(run);
    return multitaskTui.formatTaskBoardLines(this.state, { selectedKey: this.selectedKey(), maxRuns: 4, maxTasksPerGroup: 8 });
  }

  render(width) {
    const renderWidth = Math.max(20, width || 80);
    const rawTitle = `Porchestrator — ${panelViewLabels[this.view] || this.view}`;
    const title = this.theme?.fg ? this.theme.fg("accent", this.theme.bold ? this.theme.bold(rawTitle) : rawTitle) : rawTitle;
    const footerText = "↑↓ select · b board · l runs · i detail · t tail · d diff · v review · g integration · u refresh · m/s message/steer · x abort · R review · M merge · a apply · c cleanup · q close";
    const footer = this.theme?.fg ? this.theme.fg("dim", footerText) : footerText;
    const generated = this.state.generatedAt ? `status refreshed ${this.state.generatedAt}` : "";
    const lines = [title];
    if (generated) lines.push(this.theme?.fg ? this.theme.fg("dim", generated) : generated);
    lines.push("", ...this.renderViewLines(), "", footer);
    return lines.map((line) => truncatePanelLine(line, renderWidth));
  }
}

async function handleMultitaskPanelAction(action, ctx) {
  if (!action || action.action === "close" || action.action === "refresh") return;
  const { runId, taskId } = action;
  if (!runId) return ctx.ui.notify("Select a multitask run first.", "warning");
  const taskAction = !["applyIntegration", "cleanup"].includes(action.action);
  if (taskAction && !taskId) return ctx.ui.notify("Select a multitask task first.", "warning");

  if (action.action === "message") {
    const mode = action.mode === "steer" ? "steer" : "followUp";
    const label = mode === "steer" ? "Steer" : "Message";
    const message = ctx.hasUI ? await ctx.ui.input(`${label} for ${runId}/${taskId}`) : undefined;
    if (!message) return;
    await notifyMultitaskCommand(ctx, "multitask_message", async (client) => {
      const result = await client.message({ runId, taskId, message, mode });
      return textResult(`Sent ${result.command} to ${runId}/${taskId}.`, result);
    });
    return;
  }

  if (action.action === "diff") {
    await notifyMultitaskCommand(ctx, "multitask_diff", async (client) => {
      const result = await client.diff({ runId, taskId });
      return textResult(formatCommandResult(result, "No diff available."), result);
    });
    return;
  }

  if (action.action === "review") {
    await notifyMultitaskCommand(ctx, "multitask_review", async (client) => {
      const result = await client.review({ runId, taskId });
      return textResult(formatCommandResult(result, "Review complete."), result);
    });
    return;
  }

  if (action.action === "mergeSelected") {
    if (ctx.hasUI) {
      const ok = await ctx.ui.confirm("Merge multitask task?", `Merge ${runId}/${taskId} into the integration worktree?`);
      if (!ok) return;
    }
    await notifyMultitaskCommand(ctx, "multitask_merge", async (client) => {
      const result = await client.merge({ runId, taskIds: [taskId] });
      return textResult(formatCommandResult(result, "Merge complete."), result);
    });
    return;
  }

  if (action.action === "applyIntegration") {
    if (ctx.hasUI) {
      const ok = await ctx.ui.confirm("Apply multitask integration?", `Apply run ${runId} to the current checkout?`);
      if (!ok) return;
    }
    await notifyMultitaskCommand(ctx, "multitask_apply", async (client) => {
      const result = await client.apply({ runId, approved: true });
      return textResult(formatCommandResult(result, "Apply complete."), result);
    });
    return;
  }

  if (action.action === "cleanup") {
    if (ctx.hasUI) {
      const ok = await ctx.ui.confirm("Clean up multitask run?", `Remove worktrees for ${runId}? Use /mt-cleanup ${runId} --dry-run to preview first.`);
      if (!ok) return;
    }
    await notifyMultitaskCommand(ctx, "multitask_cleanup", async (client) => {
      const result = await client.cleanup({ runId, removeState: false, dryRun: false });
      return textResult(formatCommandResult(result, "Cleanup complete."), result);
    });
    return;
  }

  if (action.action === "resume") {
    await notifyMultitaskCommand(ctx, "multitask_resume", async (client) => {
      const result = await client.resume({ runId, taskId });
      return textResult(formatCommandResult(result, "Resume complete."), result);
    });
    return;
  }

  if (action.action === "cancel") {
    if (ctx.hasUI) {
      const ok = await ctx.ui.confirm("Abort multitask worker?", `Interrupt/abort ${runId}/${taskId}?`);
      if (!ok) return;
    }
    await notifyMultitaskCommand(ctx, "multitask_cancel", async (client) => {
      const result = await client.cancel({ runId, taskId });
      return textResult(`Cancelled ${runId}/${taskId}.`, result);
    });
  }
}

async function openMultitaskPanel(ctx) {
  let selectedIndex = 0;
  let view = "board";
  for (;;) {
    let state;
    try {
      state = await loadMultitaskTuiStateForCwd(ctx.cwd, { eventLimit: 5, transcriptLimit: 20 });
    } catch (error) {
      return ctx.ui.notify(`Unable to load multitask panel: ${error.message || error}`, "warning");
    }

    if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
      ctx.ui.notify(multitaskTui.formatActiveRuns(state, { includeInactive: true }), "info");
      return;
    }

    const action = await ctx.ui.custom((tui, theme, _keybindings, done) => new MultitaskPanelComponent(state, {
      theme,
      done,
      selectedIndex,
      view,
      requestRender: () => tui.requestRender(),
    }));
    selectedIndex = action?.selectedIndex ?? selectedIndex;
    view = action?.view || view;
    if (action?.action === "refresh") continue;
    await handleMultitaskPanelAction(action, ctx);
    await refreshMultitaskWidget(ctx).catch(() => {});
    return;
  }
}

export default function piOrchestratorExtension(pi) {
  if (process.env.PI_MULTITASK_ROLE === "worker") return;

  pi.on("session_start", async (_event, ctx) => {
    startMultitaskWidgetRefresh(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopMultitaskWidgetRefresh(ctx);
    await multitaskDashboard.stopAllDashboardServers().catch(() => {});
  });

  pi.on("before_agent_start", async (event) => ({
    systemPrompt:
      event.systemPrompt +
      "\n\n# Porchestrator\n" +
      "When the user asks to multitask, parallelize, use workers, delegate, use background agents, split work across worktrees, or mentions /multitask or /mt, use the multitask tools. " +
      "Porchestrator runs persistent local Pi RPC worker sessions in isolated git worktrees while the main chat remains usable. " +
      "Preferred flow: inspect relevant files/specs; decompose into independent local-worktree tasks; tell the user the proposed workers and explicit named startupScripts/validationScripts selections from .pi/multitask/config.json; ask for approval; call multitask_start; continue helping while workers run; use multitask_status, multitask_diff, and multitask_message to monitor and steer workers; review before merge; merge/apply only after user approval. " +
      "Do not auto-detect startup or validation scripts. Choose named scripts explicitly and show the effective selections to the user. " +
      "Use multitask_message for worker follow-ups. Do not use multitask tools from worker processes.\n",
  }));

  pi.registerTool({
    name: "multitask_start",
    label: "Porchestrator Start",
    description: "Create a Porchestrator run, create local worktrees, start persistent worker sessions, and return immediately.",
    promptSnippet: "Start local background worker sessions in isolated git worktrees",
    promptGuidelines: [
      "Use multitask_start only after the user has approved the worker decomposition.",
      "Do not auto-detect scripts; pass explicit named startupScripts/validationScripts when scripts are needed.",
    ],
    parameters: Type.Object({
      runName: Type.Optional(Type.String({ description: "Human-friendly run name" })),
      runId: Type.Optional(Type.String({ description: "Optional explicit run id" })),
      baseRef: Type.Optional(Type.String({ description: "Base git ref. Default: HEAD" })),
      maxConcurrency: Type.Optional(Type.Number({ description: "Maximum workers to run concurrently" })),
      summary: Type.Optional(Type.String({ description: "Plan summary" })),
      planMarkdown: Type.Optional(Type.String({ description: "Full Markdown plan to save as plan.md" })),
      integration: Type.Optional(IntegrationScriptsSchema),
      tasks: Type.Array(MultitaskTaskSchema, { description: "Worker tasks" }),
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: "Starting Porchestrator run..." }] });
      return executeMultitask(ctx, "multitask_start", async (client) => {
        const result = await client.start(params);
        return textResult(formatStartResult(result), {
          manifest: compactMultitaskManifest(result.manifest),
          planPath: result.planPath,
          setupStarted: result.setupStarted,
        });
      });
    },
  });

  pi.registerTool({
    name: "multitask_spawn",
    label: "Porchestrator Spawn",
    description: "Add a worker to an existing Porchestrator run.",
    promptSnippet: "Add a worker to an existing multitask run",
    parameters: Type.Object({
      runId: Type.String({ description: "Run id" }),
      id: Type.String({ description: "New worker task id" }),
      title: Type.Optional(Type.String({ description: "Optional human-friendly task title" })),
      prompt: Type.String({ description: "Worker prompt/instructions" }),
      agent: Type.Optional(Type.String({ description: "Worker agent prompt to use. Default: worker" })),
      model: Type.Optional(Type.String({ description: "Optional model override for this worker" })),
      baseRef: Type.Optional(Type.String({ description: "Optional base ref for the new worker" })),
      startupScripts: Type.Optional(ScriptIdsSchema),
      validationScripts: Type.Optional(ScriptIdsSchema),
      dependencies: Type.Optional(Type.Array(Type.String({ description: "Task ids that must finish before this task starts" }))),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return executeMultitask(ctx, "multitask_spawn", async (client) => {
        const result = await client.spawn(params);
        return textResult(formatCommandResult(result, `Spawned ${params.id}.`), result);
      });
    },
  });

  pi.registerTool({
    name: "multitask_message",
    label: "Porchestrator Message",
    description: "Send a steer/follow-up/prompt message to a persistent multitask worker session.",
    promptSnippet: "Send follow-up instructions to a multitask worker",
    parameters: Type.Object({
      runId: Type.String({ description: "Run id" }),
      taskId: Type.String({ description: "Worker task id" }),
      message: Type.String({ description: "Message to send to the worker" }),
      mode: Type.Optional(MessageModeSchema),
      type: Type.Optional(MessageTypeSchema),
      correlationId: Type.Optional(Type.String({ description: "Optional typed-message correlation id" })),
      payload: Type.Optional(Type.Any({ description: "Optional typed-message payload" })),
      restartIfNeeded: Type.Optional(Type.Boolean({ description: "Restart a detached worker from its session directory before sending" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return executeMultitask(ctx, "multitask_message", async (client) => {
        const result = await client.message(params);
        return textResult(`Sent ${result.command} to ${params.runId}/${params.taskId}.`, result);
      });
    },
  });

  pi.registerTool({
    name: "multitask_resume",
    label: "Porchestrator Resume",
    description: "Restart or resume a detached multitask worker from its persisted session directory.",
    promptSnippet: "Resume detached multitask worker sessions",
    parameters: Type.Object({
      runId: Type.String({ description: "Run id" }),
      taskId: Type.Optional(Type.String({ description: "Optional worker task id. Omit to resume all restartable detached workers." })),
      message: Type.Optional(Type.String({ description: "Optional follow-up message to send after restart (requires taskId)" })),
      mode: Type.Optional(MessageModeSchema),
      type: Type.Optional(MessageTypeSchema),
      correlationId: Type.Optional(Type.String({ description: "Optional typed-message correlation id" })),
      payload: Type.Optional(Type.Any({ description: "Optional typed-message payload" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return executeMultitask(ctx, "multitask_resume", async (client) => {
        const result = await client.resume(params);
        return textResult(formatCommandResult(result, `Resume requested for ${params.runId}.`), result);
      });
    },
  });

  pi.registerTool({
    name: "multitask_status",
    label: "Porchestrator Status",
    description: "Show Porchestrator runs/tasks.",
    promptSnippet: "Show multitask run and worker status",
    parameters: Type.Object({ runId: Type.Optional(Type.String({ description: "Run id. Omit to list runs." })) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return executeMultitask(ctx, "multitask_status", async (client) => {
        const result = await client.status(params);
        return textResult(result.summary || formatRunStatus(result.manifest), result.manifest ? compactMultitaskManifest(result.manifest) : { runs: result.runs?.map(compactMultitaskManifest) });
      });
    },
  });

  pi.registerTool({
    name: "multitask_diff",
    label: "Porchestrator Diff",
    description: "Show changed files and diff summary for a task or integration worktree.",
    promptSnippet: "Show multitask task or integration diff",
    parameters: Type.Object({
      runId: Type.String({ description: "Run id" }),
      taskId: Type.Optional(Type.String({ description: "Optional worker task id" })),
      integration: Type.Optional(Type.Boolean({ description: "Show integration worktree diff" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return executeMultitask(ctx, "multitask_diff", async (client) => {
        const result = await client.diff(params);
        return textResult(formatCommandResult(result, "No diff available."), result);
      });
    },
  });

  pi.registerTool({
    name: "multitask_review",
    label: "Porchestrator Review",
    description: "Run review for one task or all reviewable multitask tasks.",
    promptSnippet: "Review multitask worker output",
    parameters: Type.Object({
      runId: Type.String({ description: "Run id" }),
      taskId: Type.Optional(Type.String({ description: "Optional worker task id" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return executeMultitask(ctx, "multitask_review", async (client) => {
        const result = await client.review(params);
        return textResult(formatCommandResult(result, "Review complete."), result);
      });
    },
  });

  pi.registerTool({
    name: "multitask_merge",
    label: "Porchestrator Merge",
    description: "Merge selected ready multitask tasks into the integration worktree.",
    promptSnippet: "Merge multitask worker results into integration",
    promptGuidelines: ["Use multitask_merge only after review and user approval."],
    parameters: Type.Object({
      runId: Type.String({ description: "Run id" }),
      taskIds: Type.Optional(Type.Array(Type.String(), { description: "Task ids to merge. Omit for all ready tasks." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return executeMultitask(ctx, "multitask_merge", async (client) => {
        const result = await client.merge(params);
        return textResult(formatCommandResult(result, "Merge complete."), result);
      });
    },
  });

  pi.registerTool({
    name: "multitask_apply",
    label: "Porchestrator Apply",
    description: "Apply/merge the integration branch back to the foreground checkout.",
    promptSnippet: "Apply multitask integration results to the current checkout",
    promptGuidelines: ["Use multitask_apply only after explicit user approval."],
    parameters: Type.Object({
      runId: Type.String({ description: "Run id" }),
      requireClean: Type.Optional(Type.Boolean({ description: "Require a clean foreground checkout before applying. Default: true" })),
      approved: Type.Optional(Type.Boolean({ description: "Set true only after explicit user approval to apply this run." })),
      confirm: Type.Optional(Type.String({ description: "Non-interactive confirmation token: apply <runId>" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const applyParams = { ...params };
      if (ctx.hasUI) {
        const ok = await ctx.ui.confirm("Apply multitask integration?", `Apply run ${params.runId} to the current checkout?`);
        if (!ok) return textResult(`Cancelled apply for ${params.runId}.`, { cancelled: true });
        applyParams.approved = true;
      }
      return executeMultitask(ctx, "multitask_apply", async (client) => {
        const result = await client.apply(applyParams);
        return textResult(formatCommandResult(result, "Apply complete."), result);
      });
    },
  });

  pi.registerTool({
    name: "multitask_cancel",
    label: "Porchestrator Cancel",
    description: "Cancel a multitask worker or whole run.",
    promptSnippet: "Cancel multitask worker sessions or runs",
    parameters: Type.Object({
      runId: Type.String({ description: "Run id" }),
      taskId: Type.Optional(Type.String({ description: "Optional worker task id. Omit to cancel the whole run." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return executeMultitask(ctx, "multitask_cancel", async (client) => {
        const result = await client.cancel(params);
        return textResult(`Cancelled ${params.taskId ? `${params.runId}/${params.taskId}` : params.runId}.`, result.manifest ? compactMultitaskManifest(result.manifest) : result);
      });
    },
  });

  pi.registerCommand("multitask", {
    description: "Ask the agent to use Porchestrator mode for a request.",
    handler: async (args) => {
      pi.sendUserMessage(multitaskRequestText(args));
    },
  });

  pi.registerCommand("mt", {
    description: "Alias for /multitask.",
    handler: async (args) => {
      pi.sendUserMessage(multitaskRequestText(args));
    },
  });

  pi.registerCommand("mt-panel", {
    description: "Open the Porchestrator task panel.",
    handler: async (_args, ctx) => {
      await openMultitaskPanel(ctx);
    },
  });

  pi.registerCommand("mt-dashboard", {
    description: "Open the local Porchestrator web dashboard. Usage: /mt-dashboard [run-id|status|stop] [--open]",
    handler: handleMultitaskDashboardCommand,
  });

  pi.registerCommand("mt-status", {
    description: "Show multitask status. Usage: /mt-status [run-id]",
    handler: async (args, ctx) => {
      const runId = args?.trim() || undefined;
      await notifyMultitaskCommand(ctx, "multitask_status", async (client) => {
        const result = await client.status({ runId });
        return textResult(result.summary || formatRunStatus(result.manifest), result);
      });
    },
  });

  pi.registerCommand("mt-send", {
    description: "Send a message to a multitask worker. Usage: /mt-send <run-id> <task-id> [message]",
    handler: async (args, ctx) => {
      const [runId, taskId, rest] = splitCommandArgs(args, 3);
      if (!runId || !taskId) return ctx.ui.notify("Usage: /mt-send <run-id> <task-id> [message]", "warning");
      const restartIfNeeded = /(^|\s)--restart(\s|$)/.test(rest || "");
      const cleanedRest = restartIfNeeded ? String(rest || "").replace(/(^|\s)--restart(\s|$)/, " ").trim() : rest;
      const message = cleanedRest || (ctx.hasUI ? await ctx.ui.input(`Message for ${runId}/${taskId}`) : undefined);
      if (!message) return ctx.ui.notify("No message provided.", "warning");
      await notifyMultitaskCommand(ctx, "multitask_message", async (client) => {
        const result = await client.message({ runId, taskId, message, restartIfNeeded });
        return textResult(`Sent ${result.command} to ${runId}/${taskId}.`, result);
      });
    },
  });

  pi.registerCommand("mt-diff", {
    description: "Show multitask diff. Usage: /mt-diff <run-id> [task-id]",
    handler: async (args, ctx) => {
      const [runId, taskId] = splitCommandArgs(args, 2);
      if (!runId) return ctx.ui.notify("Usage: /mt-diff <run-id> [task-id]", "warning");
      await notifyMultitaskCommand(ctx, "multitask_diff", async (client) => {
        const result = await client.diff({ runId, taskId });
        return textResult(formatCommandResult(result, "No diff available."), result);
      });
    },
  });

  pi.registerCommand("mt-review", {
    description: "Review multitask output. Usage: /mt-review <run-id> [task-id]",
    handler: async (args, ctx) => {
      const [runId, taskId] = splitCommandArgs(args, 2);
      if (!runId) return ctx.ui.notify("Usage: /mt-review <run-id> [task-id]", "warning");
      await notifyMultitaskCommand(ctx, "multitask_review", async (client) => {
        const result = await client.review({ runId, taskId });
        return textResult(formatCommandResult(result, "Review complete."), result);
      });
    },
  });

  pi.registerCommand("mt-merge", {
    description: "Merge multitask tasks into integration. Usage: /mt-merge <run-id> [task-id...]",
    handler: async (args, ctx) => {
      const parts = parseTaskIds(args);
      const runId = parts.shift();
      if (!runId) return ctx.ui.notify("Usage: /mt-merge <run-id> [task-id...]", "warning");
      await notifyMultitaskCommand(ctx, "multitask_merge", async (client) => {
        const result = await client.merge({ runId, taskIds: parts.length ? parts : undefined });
        return textResult(formatCommandResult(result, "Merge complete."), result);
      });
    },
  });

  pi.registerCommand("mt-apply", {
    description: "Apply multitask integration to the foreground checkout. Usage: /mt-apply <run-id>",
    handler: async (args, ctx) => {
      const runId = args?.trim();
      if (!runId) return ctx.ui.notify("Usage: /mt-apply <run-id>", "warning");
      if (ctx.hasUI) {
        const ok = await ctx.ui.confirm("Apply multitask integration?", `Apply run ${runId} to the current checkout?`);
        if (!ok) return;
      }
      await notifyMultitaskCommand(ctx, "multitask_apply", async (client) => {
        const result = await client.apply({ runId, approved: true });
        return textResult(formatCommandResult(result, "Apply complete."), result);
      });
    },
  });

  pi.registerCommand("mt-cancel", {
    description: "Cancel a multitask run or worker. Usage: /mt-cancel <run-id> [task-id]",
    handler: async (args, ctx) => {
      const [runId, taskId] = splitCommandArgs(args, 2);
      if (!runId) return ctx.ui.notify("Usage: /mt-cancel <run-id> [task-id]", "warning");
      await notifyMultitaskCommand(ctx, "multitask_cancel", async (client) => {
        const result = await client.cancel({ runId, taskId });
        return textResult(`Cancelled ${taskId ? `${runId}/${taskId}` : runId}.`, result);
      });
    },
  });

  pi.registerCommand("mt-cleanup", {
    description: "Clean up multitask worktrees/state. Usage: /mt-cleanup <run-id> [--state] [--dry-run]",
    handler: async (args, ctx) => {
      const parts = parseTaskIds(args);
      const runId = parts.find((part) => !part.startsWith("--"));
      if (!runId) return ctx.ui.notify("Usage: /mt-cleanup <run-id> [--state] [--dry-run]", "warning");
      const removeState = parts.includes("--state");
      const dryRun = parts.includes("--dry-run");
      if (ctx.hasUI && !dryRun) {
        const ok = await ctx.ui.confirm("Clean up multitask run?", `Remove worktrees${removeState ? " and state" : ""} for ${runId}?`);
        if (!ok) return;
      }
      await notifyMultitaskCommand(ctx, "multitask_cleanup", async (client) => {
        const result = await client.cleanup({ runId, removeState, dryRun });
        return textResult(formatCommandResult(result, "Cleanup complete."), result);
      });
    },
  });

  pi.registerCommand("mt-resume", {
    description: "Resume/restart detached multitask workers. Usage: /mt-resume <run-id> [task-id] [message]",
    handler: async (args, ctx) => {
      const [runId, taskId, rest] = splitCommandArgs(args, 3);
      if (!runId) return ctx.ui.notify("Usage: /mt-resume <run-id> [task-id] [message]", "warning");
      await notifyMultitaskCommand(ctx, "multitask_resume", async (client) => {
        const result = await client.resume({ runId, taskId, message: rest || undefined });
        return textResult(formatCommandResult(result, "Resume complete."), result);
      });
    },
  });

  pi.registerCommand("mt-agents", {
    description: "List available Porchestrator agents and trust provenance. Usage: /mt-agents",
    handler: async (_args, ctx) => {
      await notifyMultitaskCommand(ctx, "multitask_agents", async (client) => {
        const result = await client.agents({ includeProject: true });
        return textResult(result.summary || "No multitask agents found.", result);
      });
    },
  });

  pi.registerCommand("mt-doctor", {
    description: "Diagnose Porchestrator runtime state. Usage: /mt-doctor [run-id]",
    handler: async (args, ctx) => {
      const runId = args?.trim() || undefined;
      await notifyMultitaskCommand(ctx, "multitask_doctor", async (client) => {
        const result = await client.doctor({ runId });
        return textResult(result.formatted || result.summary || "Doctor complete.", result);
      });
    },
  });

  pi.registerCommand("mt-export", {
    description: "Export a multitask run bundle. Usage: /mt-export <run-id> [output-path]",
    handler: async (args, ctx) => {
      const [runId, outputPath] = splitCommandArgs(args, 2);
      if (!runId) return ctx.ui.notify("Usage: /mt-export <run-id> [output-path]", "warning");
      await notifyMultitaskCommand(ctx, "multitask_export", async (client) => {
        const result = await client.export({ runId, outputPath });
        return textResult(result.formatted || result.summary || "Export complete.", result);
      });
    },
  });

  pi.registerCommand("mt-prune", {
    description: "Preview or prune old Porchestrator runs. Usage: /mt-prune [run-id] [--all] [--state] [--worktrees] [--delete] [--force]",
    handler: async (args, ctx) => {
      const parts = parseTaskIds(args);
      const runId = parts.find((part) => !part.startsWith("--"));
      const dryRun = !parts.includes("--delete");
      const removeState = parts.includes("--state") || parts.includes("--all");
      const removeWorktrees = parts.includes("--worktrees") || parts.includes("--all") || !removeState;
      const force = parts.includes("--force");
      let confirm;
      if (!dryRun && ctx.hasUI && !force) {
        confirm = await ctx.ui.input("Type the exact confirmation phrase shown in the dry-run output, or leave blank to preview only.");
      }
      await notifyMultitaskCommand(ctx, "multitask_prune", async (client) => {
        const result = await client.prune({ runId, removeState, removeWorktrees, dryRun, force, confirm });
        return textResult(result.formatted || result.summary || "Prune complete.", result);
      });
    },
  });

  pi.registerCommand("mt-config", {
    description: "Create, show, validate, or edit named script config used by Porchestrator. Usage: /mt-config [show|validate|init|add-script|set-defaults]",
    handler: handleMultitaskConfigCommand,
  });
};
