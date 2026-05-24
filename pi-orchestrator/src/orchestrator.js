const { loadConfig, resolvePhaseScripts, scriptIds } = require("./config.js");
const {
  branchExists,
  branchFor,
  commitExists,
  createWorktree,
  getCurrentCommit,
  getRefCommit,
  getRepoInfo,
  git,
  isDirty,
  mergeBranch,
  removeWorktree,
  requireCleanRepo,
  worktreePathFor,
} = require("./git.js");
const { runStartupScripts, runValidationScripts } = require("./hooks.js");
const { listRuns, loadManifest, runDir, saveManifest, writePlan } = require("./manifest.js");
const { MockWorkerRunner, PiSubprocessWorkerRunner } = require("./worker-runner.js");
const { createRunId, ensureDir, fsp, path, pathExists, relPath, slugify } = require("./utils.js");

const DEFAULT_MAX_CONCURRENCY = 4;

function normalizeTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("At least one task is required.");
  const seen = new Set();
  return tasks.map((task, index) => {
    const id = slugify(task.id || task.name || `task-${index + 1}`, `task-${index + 1}`);
    if (seen.has(id)) throw new Error(`Duplicate orchestrator task id: ${id}`);
    seen.add(id);
    if (!task.task || typeof task.task !== "string") throw new Error(`Task ${id} is missing a task string.`);
    return { ...task, id, agent: task.agent || "worker" };
  });
}

function createRunner(config, override) {
  if (override) return override;
  if (config.workers.runner === "mock") return new MockWorkerRunner();
  return new PiSubprocessWorkerRunner({
    model: config.workers.model,
    tools: config.workers.tools,
    allowWorkerDelegation: config.workers.allowWorkerDelegation,
  });
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(concurrency, items.length))).fill(null).map(async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function plannedTaskRecord(task, runId, config, repoRoot, worktreeMode) {
  const branch = worktreeMode === "per-task" ? branchFor(runId, task.id) : undefined;
  const worktree = worktreeMode === "per-task" ? worktreePathFor(config.worktrees.root, runId, task.id) : (task.cwd ? path.resolve(repoRoot, task.cwd) : repoRoot);
  return {
    id: task.id,
    agent: task.agent || "worker",
    task: task.task,
    branch,
    worktree,
    status: "pending",
    startupScripts: [],
    validationScripts: [],
    startupResults: [],
    validation: [],
  };
}

function resolveTaskScripts(config, task) {
  const startup = resolvePhaseScripts(
    config,
    task.startupScripts,
    config.defaults.workerStartupScripts,
    `task ${task.id} startupScripts`,
  );
  const validation = resolvePhaseScripts(
    config,
    task.validationScripts,
    config.defaults.workerValidationScripts,
    `task ${task.id} validationScripts`,
  );
  return { startup, validation };
}

function resolveIntegrationScripts(config, integrationInput = {}) {
  const startup = resolvePhaseScripts(
    config,
    integrationInput.startupScripts,
    config.defaults.integrationStartupScripts,
    "integration startupScripts",
  );
  const validation = resolvePhaseScripts(
    config,
    integrationInput.validationScripts,
    config.defaults.integrationValidationScripts,
    "integration validationScripts",
  );
  return { startup, validation };
}

function resolveRunScripts(config, tasks, integrationInput = {}) {
  const taskScripts = new Map();
  for (const task of tasks) taskScripts.set(task.id, resolveTaskScripts(config, task));
  const integration = resolveIntegrationScripts(config, integrationInput);
  return { taskScripts, integration };
}

function namedManifestScriptSelection(config, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return undefined;
  return ids.every((id) => config.scripts[id]) ? ids : undefined;
}

function resolveIntegrationScriptsForMerge(config, manifest, input = {}) {
  return resolveIntegrationScripts(config, {
    startupScripts:
      input.startupScripts !== undefined
        ? input.startupScripts
        : namedManifestScriptSelection(config, manifest.integration?.startupScripts),
    validationScripts:
      input.validationScripts !== undefined
        ? input.validationScripts
        : namedManifestScriptSelection(config, manifest.integration?.validationScripts),
  });
}

function resolveTaskValidationScriptsForVerify(config, task) {
  return resolvePhaseScripts(
    config,
    namedManifestScriptSelection(config, task.validationScripts),
    config.defaults.workerValidationScripts,
    `task ${task.id} validationScripts`,
  );
}

function manifestSummary(manifest, repoRoot) {
  const lines = [];
  lines.push(`# Orchestrator Run ${manifest.runId}`);
  lines.push(`Status: ${manifest.status}`);
  lines.push(`Base: ${manifest.baseBranch || "HEAD"} @ ${manifest.baseCommit || manifest.baseRef}`);
  lines.push("");
  lines.push("## Tasks");
  for (const task of manifest.tasks || []) {
    const commit = task.commit ? ` @ ${String(task.commit).slice(0, 12)}` : "";
    const wt = task.worktree ? ` — ${relPath(repoRoot, task.worktree)}` : "";
    lines.push(`- ${task.id}: ${task.status}${commit}${wt}`);
  }
  if (manifest.integration) {
    lines.push("");
    lines.push("## Integration");
    lines.push(`- ${manifest.integration.status || "pending"}: ${manifest.integration.branch || "(no branch)"}`);
    if (manifest.integration.worktree) lines.push(`- Worktree: ${relPath(repoRoot, manifest.integration.worktree)}`);
  }
  return lines.join("\n");
}

async function createPlan(input, options = {}) {
  const repo = await getRepoInfo(options.cwd || process.cwd());
  const config = await loadConfig(repo.root);
  const runId = slugify(input.runId || createRunId(input.runName || "plan"), "run");
  const baseRef = input.baseRef || "HEAD";
  const baseCommit = await getRefCommit(repo.root, baseRef);
  const tasks = normalizeTasks(input.tasks || []);
  const worktreeMode = input.worktreeMode || "per-task";
  const runScripts = resolveRunScripts(config, tasks, input.integration || {});
  const manifest = {
    schemaVersion: 1,
    runId,
    runName: input.runName || runId,
    status: "planned",
    createdAt: new Date().toISOString(),
    baseRef,
    baseCommit,
    baseBranch: repo.branch,
    repoRoot: repo.root,
    configPath: config.path,
    worktreeMode,
    tasks: tasks.map((task) => {
      const record = plannedTaskRecord(task, runId, config, repo.root, worktreeMode);
      const scripts = runScripts.taskScripts.get(task.id);
      record.startupScripts = scriptIds(scripts.startup);
      record.validationScripts = scriptIds(scripts.validation);
      return record;
    }),
    integration: {
      branch: branchFor(runId, "integration"),
      worktree: worktreePathFor(config.worktrees.root, runId, "integration"),
      status: "pending",
      startupScripts: scriptIds(runScripts.integration.startup),
      validationScripts: scriptIds(runScripts.integration.validation),
    },
    events: [{ time: new Date().toISOString(), type: "planned" }],
  };

  const planMarkdown = input.planMarkdown || [
    "# Orchestrator Plan",
    "",
    `Run: ${runId}`,
    `Base ref: ${baseRef} @ ${baseCommit}`,
    "",
    "## Summary",
    input.summary || "No summary provided.",
    "",
    "## Tasks",
    ...tasks.flatMap((task) => ["", `### ${task.id}`, task.task]),
    "",
  ].join("\n");

  await saveManifest(repo.root, manifest);
  await writePlan(repo.root, runId, planMarkdown);
  return { manifest, planPath: path.join(runDir(repo.root, runId), "plan.md") };
}

async function dispatch(input, options = {}) {
  const repo = await getRepoInfo(options.cwd || process.cwd());
  const config = await loadConfig(repo.root);
  const tasks = normalizeTasks(input.tasks || []);
  const runId = slugify(input.runId || createRunId(input.runName || "run"), "run");
  const baseRef = input.baseRef || "HEAD";
  const baseCommit = await getRefCommit(repo.root, baseRef);
  const worktreeMode = input.worktreeMode || "per-task";
  const runner = createRunner(config, options.runner);
  const maxConcurrency = Math.max(1, Number(input.maxConcurrency || config.workers.maxConcurrency || DEFAULT_MAX_CONCURRENCY));
  const runScripts = resolveRunScripts(config, tasks, input.integration || {});

  const dryManifest = {
    schemaVersion: 1,
    runId,
    runName: input.runName || runId,
    status: input.dryRun ? "dry-run" : "running",
    createdAt: new Date().toISOString(),
    baseRef,
    baseCommit,
    baseBranch: repo.branch,
    repoRoot: repo.root,
    configPath: config.path,
    worktreeMode,
    tasks: tasks.map((task) => {
      const record = plannedTaskRecord(task, runId, config, repo.root, worktreeMode);
      const scripts = runScripts.taskScripts.get(task.id);
      record.startupScripts = scriptIds(scripts.startup);
      record.validationScripts = scriptIds(scripts.validation);
      return record;
    }),
    integration: {
      branch: branchFor(runId, "integration"),
      worktree: worktreePathFor(config.worktrees.root, runId, "integration"),
      status: "pending",
      startupScripts: scriptIds(runScripts.integration.startup),
      validationScripts: scriptIds(runScripts.integration.validation),
    },
    events: [],
  };

  if (input.dryRun) {
    return {
      dryRun: true,
      manifest: {
        ...dryManifest,
        tasks: dryManifest.tasks.map((task, index) => ({
          ...task,
          plannedWorkerCommand: typeof runner.describeWorkerCommand === "function"
            ? runner.describeWorkerCommand({ ...tasks[index], runId, taskId: task.id, cwd: task.worktree, branch: task.branch })
            : "worker command unavailable",
        })),
      },
    };
  }

  if (worktreeMode === "per-task" && input.requireClean !== false) {
    await requireCleanRepo(repo.root);
  }

  await ensureDir(config.worktrees.root);
  let manifest = { ...dryManifest, events: [{ time: new Date().toISOString(), type: "dispatch_started" }] };
  await saveManifest(repo.root, manifest);

  try {
    for (let i = 0; i < tasks.length; i++) {
      const taskInput = tasks[i];
      const task = manifest.tasks[i];
      if (worktreeMode === "per-task") {
        task.status = "creating_worktree";
        await saveManifest(repo.root, manifest);
        await createWorktree(repo.root, task.worktree, task.branch, baseRef);
        task.status = "setup";
        await saveManifest(repo.root, manifest);
        const scripts = runScripts.taskScripts.get(task.id);
        task.startupResults = await runStartupScripts(config, task.worktree, "worker", {
          runId,
          runDir: runDir(repo.root, runId),
          taskId: task.id,
        }, scripts.startup);
      }
      task.mockChanges = taskInput.mockChanges;
      task.status = "ready";
      await saveManifest(repo.root, manifest);
    }

    await mapWithConcurrency(manifest.tasks, maxConcurrency, async (task, index) => {
      task.status = "running";
      task.startedAt = new Date().toISOString();
      await saveManifest(repo.root, manifest);
      const inputTask = tasks[index];
      try {
        const result = await runner.runWorker({
          ...inputTask,
          runId,
          taskId: task.id,
          agent: task.agent,
          cwd: task.worktree,
          branch: task.branch,
          startupScripts: task.startupResults,
          signal: options.signal,
          model: inputTask.model,
          mockChanges: inputTask.mockChanges,
        });
        task.workerResult = result;
        task.summary = result.summary;
        task.commit = result.commit;
        task.exitCode = result.exitCode;
        task.validation = await runValidationScripts(config, task.worktree, "worker", {
          runId,
          runDir: runDir(repo.root, runId),
          taskId: task.id,
        }, runScripts.taskScripts.get(task.id).validation).catch((error) => {
          task.validationError = error.message;
          return error.results || [error.commandResult].filter(Boolean);
        });
        const validationFailed = (task.validation || []).some((r) => r.status === "failed" && r.required !== false);
        const missingRequiredCommit =
          worktreeMode === "per-task" && result.status === "completed" && (!result.commit || result.commit === baseCommit);
        if (missingRequiredCommit) task.error = "Worker finished without creating a new commit.";
        task.status =
          result.status === "completed" && !validationFailed && !missingRequiredCommit
            ? "completed"
            : validationFailed
              ? "validation_failed"
              : "failed";
      } catch (error) {
        task.status = "failed";
        task.error = error.message;
        if (error.results) task.startupResults = error.results;
      } finally {
        task.completedAt = new Date().toISOString();
        await saveManifest(repo.root, manifest);
      }
    });

    const failed = manifest.tasks.filter((task) => task.status !== "completed");
    manifest.status = failed.length === 0 ? "completed" : "failed";
    manifest.events.push({ time: new Date().toISOString(), type: "dispatch_completed", failedTasks: failed.map((t) => t.id) });
    await saveManifest(repo.root, manifest);
    return { manifest };
  } catch (error) {
    manifest.status = "failed";
    manifest.error = error.message;
    manifest.events.push({ time: new Date().toISOString(), type: "dispatch_failed", error: error.message });
    await saveManifest(repo.root, manifest);
    throw error;
  }
}

async function mergeRun(input, options = {}) {
  const repo = await getRepoInfo(options.cwd || process.cwd());
  const config = await loadConfig(repo.root);
  const runId = slugify(input.runId, "run");
  const manifest = await loadManifest(repo.root, runId);
  const integration = manifest.integration || {
    branch: branchFor(manifest.runId, "integration"),
    worktree: worktreePathFor(config.worktrees.root, manifest.runId, "integration"),
    status: "pending",
  };
  manifest.integration = integration;
  const integrationScripts = resolveIntegrationScriptsForMerge(config, manifest, input);
  integration.startupScripts = scriptIds(integrationScripts.startup);
  integration.validationScripts = scriptIds(integrationScripts.validation);

  if (!(await pathExists(integration.worktree))) {
    integration.status = "creating_worktree";
    await saveManifest(repo.root, manifest);
    await ensureDir(path.dirname(integration.worktree));
    await createWorktree(repo.root, integration.worktree, integration.branch, input.baseRef || manifest.baseRef || manifest.baseCommit || "HEAD");
    integration.startupResults = await runStartupScripts(config, integration.worktree, "integration", {
      runId: manifest.runId,
      runDir: runDir(repo.root, manifest.runId),
      taskId: "integration",
    }, integrationScripts.startup);
  }

  integration.status = "merging";
  integration.merges = integration.merges || [];
  await saveManifest(repo.root, manifest);

  for (const task of manifest.tasks || []) {
    if (task.status !== "completed") continue;
    if (!task.branch) continue;
    if (integration.merges.some((m) => m.taskId === task.id && m.status === "merged")) continue;
    const result = await mergeBranch(integration.worktree, task.branch);
    const entry = {
      taskId: task.id,
      branch: task.branch,
      status: result.exitCode === 0 ? "merged" : "conflict",
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      completedAt: new Date().toISOString(),
    };
    integration.merges.push(entry);
    await saveManifest(repo.root, manifest);
    if (result.exitCode !== 0) {
      integration.status = "conflict";
      manifest.status = "integration_conflict";
      await saveManifest(repo.root, manifest);
      return { manifest, integration, conflict: entry };
    }
  }

  integration.validation = await runValidationScripts(config, integration.worktree, "integration", {
    runId: manifest.runId,
    runDir: runDir(repo.root, manifest.runId),
    taskId: "integration",
  }, integrationScripts.validation).catch((error) => {
    integration.validationError = error.message;
    return error.results || [error.commandResult].filter(Boolean);
  });
  const validationFailed = (integration.validation || []).some((r) => r.status === "failed" && r.required !== false);
  integration.commit = await getCurrentCommit(integration.worktree).catch(() => undefined);
  integration.status = validationFailed ? "validation_failed" : "ready";
  manifest.status = validationFailed ? "integration_validation_failed" : "integrated";
  manifest.events = manifest.events || [];
  manifest.events.push({ time: new Date().toISOString(), type: "integration_completed", status: integration.status });
  await saveManifest(repo.root, manifest);
  return { manifest, integration };
}

async function getStatus(input = {}, options = {}) {
  const repo = await getRepoInfo(options.cwd || process.cwd());
  if (input.runId) {
    const runId = slugify(input.runId, "run");
    const manifest = await loadManifest(repo.root, runId);
    return { manifest, summary: manifestSummary(manifest, repo.root) };
  }
  const runs = await listRuns(repo.root);
  return { runs, summary: runs.length ? runs.map((r) => `${r.runId}: ${r.status}`).join("\n") : "No orchestrator runs found." };
}

async function verifyRun(input, options = {}) {
  const repo = await getRepoInfo(options.cwd || process.cwd());
  const config = await loadConfig(repo.root);
  const runId = slugify(input.runId, "run");
  const manifest = await loadManifest(repo.root, runId);
  const checks = [];
  const add = (name, ok, details) => checks.push({ name, ok, details });

  add("manifest exists", true, runDir(repo.root, runId));
  for (const task of manifest.tasks || []) {
    add(`worktree ${task.id}`, task.worktree ? await pathExists(task.worktree) : false, task.worktree);
    add(`branch ${task.id}`, task.branch ? await branchExists(repo.root, task.branch) : true, task.branch);
    add(`commit ${task.id}`, task.commit ? await commitExists(repo.root, task.commit) : task.status !== "completed", task.commit || "no commit recorded");
    if (task.worktree && await pathExists(task.worktree)) {
      add(`dirty ${task.id}`, !(await isDirty(task.worktree)), task.worktree);
      if (input.runValidation) {
        const results = await runValidationScripts(config, task.worktree, "worker", {
          runId: manifest.runId,
          runDir: runDir(repo.root, manifest.runId),
          taskId: task.id,
        }, resolveTaskValidationScriptsForVerify(config, task)).catch((error) => error.results || [error.commandResult].filter(Boolean));
        add(`validation ${task.id}`, !results.some((r) => r.status === "failed" && r.required !== false), results);
      }
    }
  }
  if (manifest.integration?.worktree) {
    add("integration worktree", await pathExists(manifest.integration.worktree), manifest.integration.worktree);
    if (manifest.integration.branch) add("integration branch", await branchExists(repo.root, manifest.integration.branch), manifest.integration.branch);
    if (manifest.integration.commit) add("integration commit", await commitExists(repo.root, manifest.integration.commit), manifest.integration.commit);
    if (await pathExists(manifest.integration.worktree)) {
      add("integration dirty", !(await isDirty(manifest.integration.worktree)), manifest.integration.worktree);
      if (input.runValidation) {
        const integrationScripts = resolveIntegrationScriptsForMerge(config, manifest, {});
        const results = await runValidationScripts(config, manifest.integration.worktree, "integration", {
          runId: manifest.runId,
          runDir: runDir(repo.root, manifest.runId),
          taskId: "integration",
        }, integrationScripts.validation).catch((error) => error.results || [error.commandResult].filter(Boolean));
        add("integration validation", !results.some((r) => r.status === "failed" && r.required !== false), results);
      }
    }
  }
  return { ok: checks.every((check) => check.ok), checks, manifest };
}

async function cleanupRun(input, options = {}) {
  const repo = await getRepoInfo(options.cwd || process.cwd());
  const runId = slugify(input.runId, "run");
  const manifest = await loadManifest(repo.root, runId);
  const removed = [];
  for (const task of manifest.tasks || []) {
    if (task.worktree && await pathExists(task.worktree)) {
      const result = await removeWorktree(repo.root, task.worktree, { force: input.force !== false, allowFailure: true });
      removed.push({ type: "task", id: task.id, worktree: task.worktree, exitCode: result.exitCode, stderr: result.stderr });
    }
  }
  if (manifest.integration?.worktree && await pathExists(manifest.integration.worktree)) {
    const result = await removeWorktree(repo.root, manifest.integration.worktree, { force: input.force !== false, allowFailure: true });
    removed.push({ type: "integration", id: "integration", worktree: manifest.integration.worktree, exitCode: result.exitCode, stderr: result.stderr });
  }
  manifest.status = "cleaned";
  manifest.cleanup = { removed, completedAt: new Date().toISOString() };
  await saveManifest(repo.root, manifest);
  if (input.deleteManifest) await fsp.rm(runDir(repo.root, manifest.runId), { recursive: true, force: true });
  return { removed, manifest: input.deleteManifest ? undefined : manifest };
}

module.exports = {
  MockWorkerRunner,
  PiSubprocessWorkerRunner,
  cleanupRun,
  createPlan,
  dispatch,
  getStatus,
  manifestSummary,
  mergeRun,
  normalizeTasks,
  verifyRun,
};
