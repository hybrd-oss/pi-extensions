const { loadConfig, resolvePhaseScripts, scriptIds } = require("../config.js");
const { getRefCommit, getRepoInfo } = require("../git.js");
const { createRunId, ensureDir, fsp, path, pathExists, resolveMaybeRelative, slugify } = require("../utils.js");

const MULTITASK_SCHEMA_VERSION = 1;

const TASK_STATES = Object.freeze([
  "planned",
  "queued",
  "creating_worktree",
  "setup",
  "running",
  "idle",
  "needs_attention",
  "validating",
  "validation_failed",
  "ready_for_review",
  "reviewing",
  "needs_changes",
  "ready_to_merge",
  "merged",
  "failed",
  "cancelled",
]);

const RUN_STATES = Object.freeze([
  "planned",
  "starting",
  "running",
  "idle",
  "needs_attention",
  "ready_for_review",
  "merging",
  "merged",
  "failed",
  "cancelled",
]);

function multitaskRoot(repoRoot) {
  return path.join(repoRoot, ".pi", "multitask");
}

function multitaskConfigPath(repoRoot) {
  return path.join(multitaskRoot(repoRoot), "config.json");
}

function daemonSocketPath(repoRoot) {
  return path.join(multitaskRoot(repoRoot), "daemon.sock");
}

function daemonPidPath(repoRoot) {
  return path.join(multitaskRoot(repoRoot), "daemon.pid");
}

function runsRoot(repoRoot) {
  return path.join(multitaskRoot(repoRoot), "runs");
}

function runDir(repoRoot, runId) {
  return path.join(runsRoot(repoRoot), slugify(runId, "run"));
}

function manifestPath(repoRoot, runId) {
  return path.join(runDir(repoRoot, runId), "manifest.json");
}

function planPath(repoRoot, runId) {
  return path.join(runDir(repoRoot, runId), "plan.md");
}

function runEventsPath(repoRoot, runId) {
  return path.join(runDir(repoRoot, runId), "events.jsonl");
}

function tasksDir(repoRoot, runId) {
  return path.join(runDir(repoRoot, runId), "tasks");
}

function taskDir(repoRoot, runId, taskId) {
  return path.join(tasksDir(repoRoot, runId), slugify(taskId, "task"));
}

function taskStatePath(repoRoot, runId, taskId) {
  return path.join(taskDir(repoRoot, runId, taskId), "state.json");
}

function taskEventsPath(repoRoot, runId, taskId) {
  return path.join(taskDir(repoRoot, runId, taskId), "events.jsonl");
}

function taskTranscriptPath(repoRoot, runId, taskId) {
  return path.join(taskDir(repoRoot, runId, taskId), "transcript.jsonl");
}

function taskStdoutPath(repoRoot, runId, taskId) {
  return path.join(taskDir(repoRoot, runId, taskId), "stdout.log");
}

function taskStderrPath(repoRoot, runId, taskId) {
  return path.join(taskDir(repoRoot, runId, taskId), "stderr.log");
}

function taskReviewPath(repoRoot, runId, taskId) {
  return path.join(taskDir(repoRoot, runId, taskId), "review.md");
}

function taskSessionDir(repoRoot, runId, taskId) {
  return path.join(taskDir(repoRoot, runId, taskId), "session");
}

function defaultWorktreeRoot(repoRoot) {
  return path.resolve(path.dirname(repoRoot), `${path.basename(repoRoot)}-multitask-worktrees`);
}

function resolveWorktreeRoot(repoRoot, config, input = {}) {
  const configured =
    input.worktreeRoot ||
    config?.raw?.multitask?.worktrees?.root ||
    config?.raw?.multitask?.worktreeRoot ||
    config?.raw?.multitaskWorktreeRoot;
  return resolveMaybeRelative(repoRoot, configured || defaultWorktreeRoot(repoRoot));
}

function branchFor(runId, taskId) {
  return `mt/${slugify(runId, "run")}/${slugify(taskId, "task")}`;
}

function worktreePathFor(worktreeRoot, runId, taskId) {
  return path.join(worktreeRoot, slugify(runId, "run"), slugify(taskId, "task"));
}

function taskPaths(repoRoot, runId, taskId) {
  return {
    dir: taskDir(repoRoot, runId, taskId),
    state: taskStatePath(repoRoot, runId, taskId),
    events: taskEventsPath(repoRoot, runId, taskId),
    transcript: taskTranscriptPath(repoRoot, runId, taskId),
    stdout: taskStdoutPath(repoRoot, runId, taskId),
    stderr: taskStderrPath(repoRoot, runId, taskId),
    review: taskReviewPath(repoRoot, runId, taskId),
    session: taskSessionDir(repoRoot, runId, taskId),
  };
}

function normalizeTaskInputs(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("At least one multitask task is required.");
  const seen = new Set();
  return tasks.map((task, index) => {
    const id = slugify(task?.id || task?.name || task?.title || `task-${index + 1}`, `task-${index + 1}`);
    if (seen.has(id)) throw new Error(`Duplicate multitask task id: ${id}`);
    seen.add(id);
    const prompt = task?.prompt || task?.task;
    if (!prompt || typeof prompt !== "string") throw new Error(`Task ${id} is missing a prompt string.`);
    return {
      ...task,
      id,
      title: task.title ? String(task.title) : undefined,
      prompt,
      agent: task.agent || "worker",
    };
  });
}

function resolveTaskScripts(config, task) {
  return {
    startup: resolvePhaseScripts(
      config,
      task.startupScripts,
      config.defaults.workerStartupScripts,
      `multitask task ${task.id} startupScripts`,
    ),
    validation: resolvePhaseScripts(
      config,
      task.validationScripts,
      config.defaults.workerValidationScripts,
      `multitask task ${task.id} validationScripts`,
    ),
  };
}

function resolveIntegrationScripts(config, integration = {}) {
  return {
    startup: resolvePhaseScripts(
      config,
      integration.startupScripts,
      config.defaults.integrationStartupScripts,
      "multitask integration startupScripts",
    ),
    validation: resolvePhaseScripts(
      config,
      integration.validationScripts,
      config.defaults.integrationValidationScripts,
      "multitask integration validationScripts",
    ),
  };
}

function coerceMaxConcurrency(value, fallback = 4) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function createTaskRecord(task, context) {
  const now = context.now;
  const scripts = context.taskScripts.get(task.id) || { startup: [], validation: [] };
  return {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    agent: task.agent || "worker",
    model: task.model,
    status: "planned",
    createdAt: now,
    updatedAt: now,
    branch: branchFor(context.runId, task.id),
    worktree: worktreePathFor(context.worktreeRoot, context.runId, task.id),
    startupScripts: scriptIds(scripts.startup),
    validationScripts: scriptIds(scripts.validation),
    startupResults: [],
    validation: [],
    paths: taskPaths(context.repoRoot, context.runId, task.id),
  };
}

async function buildManifest(input, options = {}) {
  const repo = options.repo || await getRepoInfo(options.cwd || process.cwd());
  const config = options.config || await loadConfig(repo.root);
  const runId = slugify(input.runId || createRunId(input.runName || "multitask"), "run");
  const runName = input.runName || runId;
  const baseRef = input.baseRef || "HEAD";
  const baseCommit = input.baseCommit || await getRefCommit(repo.root, baseRef);
  const tasks = normalizeTaskInputs(input.tasks || []);
  const worktreeRoot = resolveWorktreeRoot(repo.root, config, input);
  const now = new Date().toISOString();
  const taskScripts = new Map(tasks.map((task) => [task.id, resolveTaskScripts(config, task)]));
  const integrationScripts = resolveIntegrationScripts(config, input.integration || {});
  const context = { repoRoot: repo.root, runId, worktreeRoot, now, taskScripts };

  return {
    schemaVersion: MULTITASK_SCHEMA_VERSION,
    kind: "pi-multitask-run",
    runId,
    runName,
    status: "planned",
    createdAt: now,
    updatedAt: now,
    baseRef,
    baseCommit,
    baseBranch: repo.branch,
    repoRoot: repo.root,
    configPath: config.path,
    multitaskConfigPath: multitaskConfigPath(repo.root),
    stateDir: runDir(repo.root, runId),
    worktreeRoot,
    maxConcurrency: coerceMaxConcurrency(input.maxConcurrency, config.workers.maxConcurrency || 4),
    tasks: tasks.map((task) => createTaskRecord(task, context)),
    integration: {
      id: "integration",
      status: "planned",
      branch: branchFor(runId, "integration"),
      worktree: worktreePathFor(worktreeRoot, runId, "integration"),
      startupScripts: scriptIds(integrationScripts.startup),
      validationScripts: scriptIds(integrationScripts.validation),
      startupResults: [],
      validation: [],
    },
    daemon: {
      socketPath: daemonSocketPath(repo.root),
      pidPath: daemonPidPath(repo.root),
    },
  };
}

async function saveManifest(repoRoot, manifest) {
  const runPath = runDir(repoRoot, manifest.runId);
  await ensureDir(runPath);
  manifest.updatedAt = new Date().toISOString();
  await fsp.writeFile(manifestPath(repoRoot, manifest.runId), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return manifest;
}

async function loadManifest(repoRoot, runId) {
  const file = manifestPath(repoRoot, runId);
  if (!(await pathExists(file))) throw new Error(`No multitask manifest found for run ${runId} at ${file}`);
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

async function saveTaskState(repoRoot, runId, task) {
  await ensureDir(taskDir(repoRoot, runId, task.id));
  task.updatedAt = new Date().toISOString();
  await fsp.writeFile(taskStatePath(repoRoot, runId, task.id), JSON.stringify(task, null, 2) + "\n", "utf8");
  return task;
}

async function loadTaskState(repoRoot, runId, taskId) {
  const file = taskStatePath(repoRoot, runId, taskId);
  if (!(await pathExists(file))) throw new Error(`No multitask task state found for ${runId}/${taskId} at ${file}`);
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

async function writePlan(repoRoot, runId, markdown) {
  await ensureDir(runDir(repoRoot, runId));
  await fsp.writeFile(planPath(repoRoot, runId), markdown || "", "utf8");
}

async function initializeRunState(repoRoot, manifest, options = {}) {
  await ensureDir(multitaskRoot(repoRoot));
  await ensureDir(runDir(repoRoot, manifest.runId));
  await ensureDir(tasksDir(repoRoot, manifest.runId));
  for (const task of manifest.tasks || []) {
    await ensureDir(taskDir(repoRoot, manifest.runId, task.id));
    await ensureDir(taskSessionDir(repoRoot, manifest.runId, task.id));
    await saveTaskState(repoRoot, manifest.runId, task);
  }
  await saveManifest(repoRoot, manifest);
  if (options.planMarkdown !== undefined) await writePlan(repoRoot, manifest.runId, options.planMarkdown);
  return manifest;
}

async function createRunState(input, options = {}) {
  const manifest = await buildManifest(input, options);
  const planMarkdown = input.planMarkdown !== undefined
    ? input.planMarkdown
    : [
      "# Multitask Run",
      "",
      `Run: ${manifest.runId}`,
      `Base ref: ${manifest.baseRef} @ ${manifest.baseCommit}`,
      "",
      "## Summary",
      input.summary || "No summary provided.",
      "",
      "## Tasks",
      ...manifest.tasks.flatMap((task) => ["", `### ${task.id}`, task.prompt]),
      "",
    ].join("\n");
  await initializeRunState(manifest.repoRoot, manifest, { planMarkdown });
  return { manifest, planPath: planPath(manifest.repoRoot, manifest.runId) };
}

async function updateManifest(repoRoot, runId, updater) {
  const manifest = await loadManifest(repoRoot, runId);
  const result = await updater(manifest);
  await saveManifest(repoRoot, manifest);
  return result === undefined ? manifest : result;
}

async function updateTask(repoRoot, runId, taskId, updater) {
  let updatedTask;
  const manifest = await updateManifest(repoRoot, runId, async (current) => {
    const task = (current.tasks || []).find((candidate) => candidate.id === slugify(taskId, "task"));
    if (!task) throw new Error(`No multitask task ${taskId} in run ${runId}.`);
    if (typeof updater === "function") await updater(task, current);
    else Object.assign(task, updater || {});
    task.updatedAt = new Date().toISOString();
    updatedTask = task;
  });
  await saveTaskState(repoRoot, runId, updatedTask);
  return { manifest, task: updatedTask };
}

async function listRuns(repoRoot) {
  const root = runsRoot(repoRoot);
  if (!(await pathExists(root))) return [];
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      runs.push(await loadManifest(repoRoot, entry.name));
    } catch {
      // Ignore malformed or partially-written run directories.
    }
  }
  runs.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return runs;
}

function summarizeRun(manifest) {
  const taskSummary = (manifest.tasks || []).map((task) => `${task.id}:${task.status}`).join(" · ");
  return `${manifest.runId}: ${manifest.status}${taskSummary ? ` (${taskSummary})` : ""}`;
}

module.exports = {
  MULTITASK_SCHEMA_VERSION,
  RUN_STATES,
  TASK_STATES,
  branchFor,
  buildManifest,
  createRunState,
  daemonPidPath,
  daemonSocketPath,
  defaultWorktreeRoot,
  initializeRunState,
  listRuns,
  loadManifest,
  loadTaskState,
  manifestPath,
  multitaskConfigPath,
  multitaskRoot,
  normalizeTaskInputs,
  planPath,
  resolveIntegrationScripts,
  resolveTaskScripts,
  resolveWorktreeRoot,
  runDir,
  runEventsPath,
  runsRoot,
  saveManifest,
  saveTaskState,
  summarizeRun,
  taskDir,
  taskEventsPath,
  taskPaths,
  taskReviewPath,
  taskSessionDir,
  taskStatePath,
  taskStderrPath,
  taskStdoutPath,
  taskTranscriptPath,
  tasksDir,
  updateManifest,
  updateTask,
  worktreePathFor,
  writePlan,
};
