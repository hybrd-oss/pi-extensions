const net = require("node:net");
const { loadConfig } = require("../config.js");
const { createWorktree, getRepoInfo } = require("../git.js");
const { runStartupScripts } = require("../hooks.js");
const { ensureDir, fsp, path, pathExists, slugify } = require("../utils.js");
const {
  METHODS,
  createLineDecoder,
  createResponse,
  defaultSocketPath,
  encodeMessage,
} = require("./daemon-protocol.js");
const {
  cleanupDaemonFilesSync,
  formatDaemonStatus,
  getDaemonStatus,
  prepareDaemonEndpoint,
  writeDaemonPid,
} = require("./lifecycle.js");
const {
  createRunState,
  daemonPidPath,
  listRuns,
  loadManifest,
  normalizeTaskInputs,
  resolveIntegrationScripts,
  resolveRunId,
  resolveTaskScripts,
  runDir,
  saveManifest,
  saveTaskState,
  summarizeRun,
  updateTask,
} = require("./manifest.js");
const {
  appendRunEvent,
  appendTaskEvent,
  initializeEventFiles,
  readRunEvents,
  readTaskEvents,
  readTranscript,
} = require("./events.js");
const {
  createWorkerSessionForTask,
  sendWorkerMessage,
  workerSessionKey,
} = require("./rpc-worker-session.js");
const { getDiff } = require("./diff.js");
const { reviewTasks } = require("./review.js");
const { applyIntegration, mergeTasks } = require("./merge.js");
const { cleanupMultitaskRun } = require("./cleanup.js");
const {
  TASK_STATUS,
  inferRunStatusFromTasks,
} = require("./contracts.js");
const { planSchedule } = require("./scheduler.js");
const { spawnTasks } = require("./spawn.js");
const {
  analyzeRunRecovery,
  formatRecoverySuggestions,
  restartIfNeeded,
} = require("./recovery.js");
const {
  normalizeSupervisorMessage,
  tryParseWorkerReport,
  workerReportToTaskTransition,
} = require("./messages.js");
const { buildDefaultWorkerSystemPrompt } = require("./rpc-worker-session.js");
const { resolveAgentForTask, listAgents } = require("./agents.js");
const { runDoctor, formatDoctorReport } = require("./doctor.js");
const { compactRunExportResult, exportMultitaskRun } = require("./export.js");
const { pruneMultitask, summarizePruneResult } = require("./prune.js");

const MULTITASK_TOOL_NAME = /^multitask_/;
const SAFE_WORKER_TOOLS = Object.freeze(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const RUN_REFERENCE_METHODS = new Set([
  METHODS.STATUS,
  METHODS.LOGS,
  METHODS.CANCEL,
  METHODS.MESSAGE,
  METHODS.DIFF,
  METHODS.REVIEW,
  METHODS.MERGE,
  METHODS.APPLY,
  METHODS.CLEANUP,
  METHODS.SPAWN,
  METHODS.RESUME,
  METHODS.DOCTOR,
  METHODS.EXPORT,
  METHODS.PRUNE,
]);

function stripMultitaskTools(tools) {
  if (tools === undefined || tools === null) return tools;
  const list = Array.isArray(tools) ? tools : String(tools).split(",");
  const filtered = list.map((tool) => String(tool).trim()).filter((tool) => tool && !MULTITASK_TOOL_NAME.test(tool));
  return filtered.length ? filtered : [...SAFE_WORKER_TOOLS];
}

function taskById(manifest, taskId) {
  const text = String(taskId || "");
  const normalized = slugify(text, "task");
  return (manifest.tasks || []).find((task) => task.id === text || task.id === normalized);
}

function assistantMessageText(message) {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      if (typeof part?.text === "string") return part.text;
      return "";
    }).filter(Boolean).join("\n");
  }
  if (typeof message.text === "string") return message.text;
  return "";
}

function lastAssistantText(messages = []) {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") return assistantMessageText(messages[index]);
  }
  return "";
}

function hasMeaningfulWorkerChange(task, patch = {}) {
  const nextWorker = { ...(task.worker || {}), ...(patch.worker || {}) };
  const workerChanged = JSON.stringify(task.worker || {}) !== JSON.stringify(nextWorker);
  const statusChanged = patch.status && patch.status !== task.status;
  return workerChanged || statusChanged || Boolean(patch.recovery && JSON.stringify(task.recovery || {}) !== JSON.stringify(patch.recovery));
}

async function applyRecoveryToManifest(repoRoot, manifest, options = {}) {
  const recovery = await analyzeRunRecovery(manifest, {
    repoRoot,
    workerSessions: options.workerSessions,
    assumeExistingSessionDirHasEntries: options.assumeExistingSessionDirHasEntries,
  });
  let changed = false;
  for (const classification of recovery.tasks || []) {
    const task = taskById(manifest, classification.taskId);
    if (!task) continue;
    const patch = classification.suggestedTaskPatch || {};
    const workerPatch = {
      ...(patch.worker || {}),
      ...(classification.worker || {}),
      attachmentState: classification.attachmentState,
      recoveryReason: classification.restartPolicy?.reason || classification.reason,
      recoveryAction: classification.restartPolicy?.action,
      sessionDir: classification.sessionDir || task.worker?.sessionDir || task.paths?.session,
    };
    const effectivePatch = {
      ...patch,
      worker: workerPatch,
    };
    if (!options.applyStatusChanges) delete effectivePatch.status;
    if (!hasMeaningfulWorkerChange(task, effectivePatch)) continue;
    if (effectivePatch.status) task.status = effectivePatch.status;
    if (effectivePatch.recovery) task.recovery = effectivePatch.recovery;
    task.worker = { ...(task.worker || {}), ...effectivePatch.worker };
    task.updatedAt = new Date().toISOString();
    await saveTaskState(repoRoot, manifest.runId, task);
    await appendTaskEvent(repoRoot, manifest.runId, task.id, "worker_recovery_classified", {
      attachmentState: classification.attachmentState,
      reason: classification.reason,
      recoveryAction: classification.restartPolicy?.action,
      status: task.status,
    });
    changed = true;
  }
  if (changed) {
    manifest.status = inferRunStatusFromTasks(manifest.tasks || []);
    await saveManifest(repoRoot, manifest);
  }
  return { manifest, recovery };
}

async function setRunStatus(repoRoot, manifest, status, extra = {}) {
  Object.assign(manifest, extra, { status, updatedAt: new Date().toISOString() });
  await saveManifest(repoRoot, manifest);
  await appendRunEvent(repoRoot, manifest.runId, "run_status_changed", { status, ...extra });
  return manifest;
}

async function setTaskStatus(repoRoot, manifest, task, status, extra = {}) {
  Object.assign(task, extra, { status, updatedAt: new Date().toISOString() });
  await saveTaskState(repoRoot, manifest.runId, task);
  await saveManifest(repoRoot, manifest);
  await appendTaskEvent(repoRoot, manifest.runId, task.id, "task_status_changed", { status, ...extra });
  return task;
}

async function createTaskWorktree(repoRoot, manifest, task, context = {}) {
  const baseRef = context.baseRef || manifest.baseRef || manifest.baseCommit || "HEAD";
  await setTaskStatus(repoRoot, manifest, task, "creating_worktree");
  await ensureDir(path.dirname(task.worktree));
  if (await pathExists(task.worktree)) throw new Error(`Task worktree already exists for ${task.id}: ${task.worktree}`);
  await createWorktree(repoRoot, task.worktree, task.branch, baseRef, context.worktreeOptions || {});
  await setTaskStatus(repoRoot, manifest, task, "setup");

  const startupScripts = context.startupScripts || [];
  task.startupResults = await runStartupScripts(context.config, task.worktree, "worker", {
    runId: manifest.runId,
    runDir: runDir(repoRoot, manifest.runId),
    taskId: task.id,
  }, startupScripts);
  await saveTaskState(repoRoot, manifest.runId, task);
  await saveManifest(repoRoot, manifest);
  await appendTaskEvent(repoRoot, manifest.runId, task.id, "task_worktree_ready", {
    branch: task.branch,
    worktree: task.worktree,
    startupScripts: task.startupScripts,
  });
  return task;
}

async function createIntegrationWorktree(repoRoot, manifest, context = {}) {
  if (!manifest.integration) return undefined;
  const integration = manifest.integration;
  const baseRef = context.baseRef || manifest.baseRef || manifest.baseCommit || "HEAD";
  integration.status = "creating_worktree";
  integration.updatedAt = new Date().toISOString();
  await saveManifest(repoRoot, manifest);
  await appendRunEvent(repoRoot, manifest.runId, "integration_status_changed", { status: integration.status });

  await ensureDir(path.dirname(integration.worktree));
  if (await pathExists(integration.worktree)) throw new Error(`Integration worktree already exists: ${integration.worktree}`);
  await createWorktree(repoRoot, integration.worktree, integration.branch, baseRef, context.worktreeOptions || {});
  integration.status = "setup";
  integration.startupResults = await runStartupScripts(context.config, integration.worktree, "integration", {
    runId: manifest.runId,
    runDir: runDir(repoRoot, manifest.runId),
    taskId: "integration",
  }, context.startupScripts || []);
  integration.status = "idle";
  integration.updatedAt = new Date().toISOString();
  await saveManifest(repoRoot, manifest);
  await appendRunEvent(repoRoot, manifest.runId, "integration_worktree_ready", {
    branch: integration.branch,
    worktree: integration.worktree,
  });
  return integration;
}

async function setupRunWorktrees(manifest, context = {}) {
  const repoRoot = context.repoRoot || manifest.repoRoot;
  const config = context.config || await loadConfig(repoRoot);
  await ensureDir(manifest.worktreeRoot);
  await setRunStatus(repoRoot, manifest, "running");

  for (const task of manifest.tasks || []) {
    try {
      const startupScripts = context.taskScripts?.get(task.id)?.startup || [];
      await createTaskWorktree(repoRoot, manifest, task, { ...context, config, startupScripts });
      await setTaskStatus(repoRoot, manifest, task, TASK_STATUS.QUEUED, {
        queuedAt: new Date().toISOString(),
        note: context.scheduler ? "Worker session startup is managed by the daemon scheduler." : "Worker session startup is pending daemon scheduler integration.",
      });
      if (!context.scheduler) {
        await appendTaskEvent(repoRoot, manifest.runId, task.id, "worker_start_pending", {
          reason: "No daemon scheduler was provided for this setup path.",
        });
      }
    } catch (error) {
      await setTaskStatus(repoRoot, manifest, task, "failed", { error: error.message });
      await appendTaskEvent(repoRoot, manifest.runId, task.id, "task_setup_failed", { error: error.message });
    }
  }

  if (context.createIntegration === true && manifest.integration) {
    try {
      await createIntegrationWorktree(repoRoot, manifest, {
        ...context,
        config,
        startupScripts: context.integrationScripts?.startup || [],
      });
    } catch (error) {
      manifest.integration.status = "failed";
      manifest.integration.error = error.message;
      await saveManifest(repoRoot, manifest);
      await appendRunEvent(repoRoot, manifest.runId, "integration_setup_failed", { error: error.message });
    }
  }

  let latestManifest = await loadManifest(repoRoot, manifest.runId).catch(() => manifest);
  if (typeof context.scheduler === "function") {
    latestManifest = await context.scheduler(latestManifest, { reason: "setup_completed" }) || await loadManifest(repoRoot, manifest.runId).catch(() => latestManifest);
  } else {
    const finalStatus = inferRunStatusFromTasks(latestManifest.tasks || []);
    await setRunStatus(repoRoot, latestManifest, finalStatus, { setupCompletedAt: new Date().toISOString() });
  }
  return latestManifest;
}

async function createLocalRun(input, options = {}) {
  const repo = options.repo || await getRepoInfo(options.cwd || process.cwd());
  const config = options.config || await loadConfig(repo.root);
  const result = await createRunState(input, { ...options, repo, config });
  await initializeEventFiles(repo.root, result.manifest);
  return { ...result, repo, config };
}

async function startRun(input, options = {}) {
  const normalizedTasks = normalizeTaskInputs(input.tasks || []);
  const { manifest, planPath, repo, config } = await createLocalRun(input, options);
  await setRunStatus(repo.root, manifest, "starting", { startedAt: new Date().toISOString() });

  const taskScripts = new Map(normalizedTasks.map((task) => [task.id, resolveTaskScripts(config, task)]));
  const integrationScripts = resolveIntegrationScripts(config, input.integration || {});
  const background = setupRunWorktrees(manifest, {
    ...options,
    repoRoot: repo.root,
    config,
    taskScripts,
    integrationScripts,
    createIntegration: input.integration?.createWorktree === true,
  }).catch(async (error) => {
    manifest.error = error.message;
    await setRunStatus(repo.root, manifest, "failed");
    await appendRunEvent(repo.root, manifest.runId, "run_setup_failed", { error: error.message });
  });

  if (options.awaitSetup === true) await background;
  const response = { manifest, planPath, setupStarted: true };
  if (options.returnBackground === true) response.background = background;
  return response;
}

async function getStatus(input = {}, options = {}) {
  const repo = options.repo || await getRepoInfo(options.cwd || process.cwd());
  const daemonStatus = await getDaemonStatus(repo.root).catch(() => undefined);
  const withRecovery = async (manifest) => {
    if (options.includeRecovery === false) return { manifest, recovery: undefined };
    const result = await applyRecoveryToManifest(repo.root, manifest, {
      workerSessions: options.workerSessions,
      applyStatusChanges: options.applyRecovery === true,
    });
    return result;
  };
  if (input.runId) {
    let manifest = await loadManifest(repo.root, input.runId);
    const { recovery } = await withRecovery(manifest);
    manifest = await loadManifest(repo.root, manifest.runId).catch(() => manifest);
    return {
      manifest,
      recovery,
      daemonStatus,
      summary: [
        summarizeRun(manifest),
        recovery?.summary,
        recovery && recovery.suggestions?.length ? formatRecoverySuggestions(recovery) : undefined,
        daemonStatus ? formatDaemonStatus(daemonStatus) : undefined,
      ].filter(Boolean).join("\n"),
    };
  }
  let runs = await listRuns(repo.root);
  const recoveries = [];
  if (options.includeRecovery !== false) {
    for (const manifest of runs) {
      const result = await withRecovery(manifest);
      recoveries.push(result.recovery);
    }
    runs = await listRuns(repo.root);
  }
  return {
    runs,
    recoveries,
    daemonStatus,
    summary: [
      runs.length ? runs.map(summarizeRun).join("\n") : "No Porchestrator runs found.",
      recoveries.map((recovery) => recovery?.summary).filter(Boolean).join("\n"),
      daemonStatus ? formatDaemonStatus(daemonStatus) : undefined,
    ].filter(Boolean).join("\n"),
  };
}

async function getLogs(input, options = {}) {
  if (!input?.runId) throw new Error("runId is required for multitask logs.");
  const repo = options.repo || await getRepoInfo(options.cwd || process.cwd());
  const lines = input.lines || 100;
  if (input.taskId) {
    return {
      events: await readTaskEvents(repo.root, input.runId, input.taskId, { lines }),
      transcript: await readTranscript(repo.root, input.runId, input.taskId, { lines }),
    };
  }
  return { events: await readRunEvents(repo.root, input.runId, { lines }) };
}

async function cancelRun(input, options = {}) {
  if (!input?.runId) throw new Error("runId is required for multitask cancel.");
  const repo = options.repo || await getRepoInfo(options.cwd || process.cwd());
  const manifest = await loadManifest(repo.root, input.runId);
  if (input.taskId) {
    const { task } = await updateTask(repo.root, manifest.runId, input.taskId, { status: "cancelled", cancelledAt: new Date().toISOString() });
    await appendTaskEvent(repo.root, manifest.runId, task.id, "task_cancelled", {});
    return { manifest: await loadManifest(repo.root, manifest.runId), task };
  }

  manifest.status = "cancelled";
  manifest.cancelledAt = new Date().toISOString();
  for (const task of manifest.tasks || []) {
    if (!["merged", "failed", "cancelled"].includes(task.status)) {
      task.status = "cancelled";
      task.cancelledAt = manifest.cancelledAt;
      await saveTaskState(repo.root, manifest.runId, task);
      await appendTaskEvent(repo.root, manifest.runId, task.id, "task_cancelled", {});
    }
  }
  await saveManifest(repo.root, manifest);
  await appendRunEvent(repo.root, manifest.runId, "run_cancelled", {});
  return { manifest };
}

class MultitaskDaemon {
  constructor(options = {}) {
    this.repoRoot = options.repoRoot;
    this.cwd = options.cwd || process.cwd();
    this.socketPath = options.socketPath;
    this.server = undefined;
    this.handlers = new Map(Object.entries(options.handlers || {}));
    this.connections = new Set();
    this.workerSessions = new Map();
    this.workerSessionOptions = options.workerSessionOptions || {};
    this.spawnOptions = options.spawnOptions || {};
    this.schedulerQueue = new Map();
    this.stopping = false;
    this.attachProcessCleanup = options.attachProcessCleanup !== false;
    this.cleanupHook = undefined;
  }

  register(method, handler) {
    this.handlers.set(method, handler);
    return this;
  }

  async resolveRepoRoot() {
    if (this.repoRoot) return this.repoRoot;
    const repo = await getRepoInfo(this.cwd);
    this.repoRoot = repo.root;
    return this.repoRoot;
  }

  async resolveSocketPath() {
    if (this.socketPath) return this.socketPath;
    this.socketPath = defaultSocketPath(await this.resolveRepoRoot());
    return this.socketPath;
  }

  async start() {
    this.stopping = false;
    const repoRoot = await this.resolveRepoRoot();
    const socketPath = await this.resolveSocketPath();
    await prepareDaemonEndpoint(repoRoot, { socketPath });

    this.server = net.createServer((socket) => this.handleConnection(socket));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(socketPath, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    await writeDaemonPid(repoRoot, process.pid);
    this.installProcessCleanupHook();
    return { socketPath, pid: process.pid };
  }

  installProcessCleanupHook() {
    if (!this.attachProcessCleanup || this.cleanupHook) return;
    this.cleanupHook = () => {
      if (this.repoRoot) cleanupDaemonFilesSync(this.repoRoot, { socketPath: this.socketPath });
    };
    process.once("exit", this.cleanupHook);
  }

  uninstallProcessCleanupHook() {
    if (!this.cleanupHook) return;
    process.off?.("exit", this.cleanupHook);
    this.cleanupHook = undefined;
  }

  async stop() {
    this.stopping = true;
    await this.stopWorkerSessions({ abort: false });
    for (const socket of this.connections) socket.destroy();
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()));
      this.server = undefined;
    }
    if (this.socketPath) await fsp.rm(this.socketPath, { force: true }).catch(() => {});
    if (this.repoRoot) await fsp.rm(daemonPidPath(this.repoRoot), { force: true }).catch(() => {});
    this.uninstallProcessCleanupHook();
  }

  async stopWorkerSessions(options = {}) {
    const results = [];
    for (const [key, session] of this.workerSessions) {
      const status = session.getStatus?.() || { key };
      await session.stop({ abort: options.abort, timeoutMs: options.timeoutMs }).then(
        async () => {
          await session.waitForPersistence?.().catch(() => {});
          results.push({ key, status: "stopped", worker: status });
        },
        (error) => results.push({ key, status: "failed", error: error.message, worker: status }),
      );
    }
    this.workerSessions.clear();
    return results;
  }

  handleConnection(socket) {
    this.connections.add(socket);
    socket.on("close", () => this.connections.delete(socket));
    const decode = createLineDecoder(
      (message) => this.handleMessage(socket, message),
      (error) => socket.write(encodeMessage(createResponse({ id: "invalid", method: "unknown" }, undefined, error))),
    );
    socket.on("data", decode);
  }

  async handleMessage(socket, message) {
    if (message.kind !== "request") return;
    try {
      const result = await this.dispatch(message.method, message.params || {});
      socket.write(encodeMessage(createResponse(message, result)));
      if (message.method === METHODS.SHUTDOWN) setImmediate(() => this.stop());
    } catch (error) {
      socket.write(encodeMessage(createResponse(message, undefined, error)));
    }
  }

  async workerLaunchOptions(context) {
    const { manifest, task, repoRoot } = context;
    const config = context.config || await loadConfig(repoRoot);
    let agentResolution;
    try {
      agentResolution = await resolveAgentForTask(task, {
        repoRoot,
        packageRoot: path.resolve(__dirname, "../.."),
        onUntrustedProjectAgent: "fallback",
        ...(this.workerSessionOptions.agentOptions || {}),
      });
    } catch (error) {
      if (task.agent && task.agent !== "worker") throw error;
    }

    const launch = agentResolution?.workerLaunchMetadata?.launchOptions || {};
    const defaultPrompt = buildDefaultWorkerSystemPrompt({ manifest, task });
    const agentPrompt = agentResolution?.workerLaunchMetadata?.promptAddition;
    const configuredTools = launch.tools || task.tools || this.workerSessionOptions.tools || config.workers?.tools;
    const tools = stripMultitaskTools(configuredTools);
    const runner = config.workers?.runner && config.workers.runner !== "mock" ? config.workers.runner : undefined;

    return {
      ...this.workerSessionOptions,
      piCommand: this.workerSessionOptions.piCommand || runner,
      model: launch.model || task.model || this.workerSessionOptions.model || config.workers?.model,
      tools,
      appendSystemPrompt: agentPrompt ? [defaultPrompt, agentPrompt] : defaultPrompt,
      agentResolution,
    };
  }

  async createWorkerSession(context) {
    const options = await this.workerLaunchOptions(context);
    const { agentResolution, ...sessionOptions } = options;
    const session = await createWorkerSessionForTask(context, sessionOptions);
    session.agentResolution = agentResolution;
    return session;
  }

  attachWorkerSessionHooks(session, context) {
    if (!session || typeof session.once !== "function" || typeof session.on !== "function") return;
    const { manifest, task, repoRoot } = context;
    const key = workerSessionKey(manifest.runId, task.id);
    session.once("exit", () => {
      this.workerSessions.delete(key);
      if (!this.stopping) this.queueSchedule(manifest.runId).catch(() => {});
    });
    session.on("event", (event) => {
      if (!this.stopping && ["agent_end", "compaction_end", "auto_retry_end", "extension_error"].includes(event?.type)) {
        this.handleWorkerSettledEvent({ runId: manifest.runId, taskId: task.id, repoRoot, session, event }).catch(() => {});
      }
    });
  }

  async handleWorkerSettledEvent(context) {
    const { runId, taskId, repoRoot, session, event } = context;
    await session.waitForPersistence?.().catch(() => {});
    let manifest = await loadManifest(repoRoot, runId).catch(() => undefined);
    if (!manifest) return;
    const task = taskById(manifest, taskId);
    if (!task) return;

    if (event?.type === "agent_end") {
      const text = lastAssistantText(event.messages);
      const report = text ? tryParseWorkerReport(text, { runId, taskId }) : undefined;
      if (report) {
        const transition = workerReportToTaskTransition(report, { fromStatus: task.status, now: new Date().toISOString() });
        Object.assign(task, transition.patch, { updatedAt: new Date().toISOString() });
        await saveTaskState(repoRoot, runId, task);
        manifest.status = inferRunStatusFromTasks(manifest.tasks || []);
        await saveManifest(repoRoot, manifest);
        await appendTaskEvent(repoRoot, runId, task.id, "worker_report_received", {
          status: transition.status,
          reason: transition.reason,
          summary: transition.summary,
          needsAttention: transition.needsAttention,
        });
        await appendRunEvent(repoRoot, runId, "worker_report", {
          taskId: task.id,
          status: transition.status,
          reason: transition.reason,
          summary: transition.summary,
        });
      }
    }

    await this.scheduleRun(runId, { repoRoot, reason: "worker_settled" });
  }

  async startWorkerSession(context) {
    const { manifest, task, repoRoot } = context;
    const key = workerSessionKey(manifest.runId, task.id);
    const existing = this.workerSessions.get(key);
    if (existing?.isAlive) return existing.getStatus();
    const session = await this.createWorkerSession({ manifest, task, repoRoot });
    this.workerSessions.set(key, session);
    this.attachWorkerSessionHooks(session, { manifest, task, repoRoot });
    try {
      await session.start();
      if (this.workerSessionOptions.sendInitialPrompt !== false) {
        await session.prompt(task.prompt, { timeoutMs: this.workerSessionOptions.initialPromptTimeoutMs || session.responseTimeoutMs });
      }
      await session.waitForPersistence?.();
    } catch (error) {
      await session.stop({ abort: false }).catch(() => {});
      this.workerSessions.delete(key);
      throw error;
    }
    return session.getStatus();
  }

  getWorkerSession(runId, taskId) {
    return this.workerSessions.get(workerSessionKey(runId, taskId));
  }

  async restartWorker(input = {}) {
    const repoRoot = input.repoRoot || await this.resolveRepoRoot();
    const result = await restartIfNeeded({
      ...input,
      repoRoot,
      workerSessions: this.workerSessions,
      restartIfNeeded: input.restartIfNeeded !== false,
    }, {
      workerSessions: this.workerSessions,
      workerSessionOptions: this.workerSessionOptions,
      createSession: async ({ manifest, task }) => {
        const session = await this.createWorkerSession({ manifest, task, repoRoot });
        this.attachWorkerSessionHooks(session, { manifest, task, repoRoot });
        return session;
      },
      startSession: async (session) => {
        await session.start();
        await session.waitForPersistence?.();
      },
      sendMessage: sendWorkerMessage,
    });
    const session = result.session;
    if (session && !session.listenerCount?.("event")) {
      const manifest = input.manifest || await loadManifest(repoRoot, result.runId);
      const task = taskById(manifest, result.taskId);
      if (task) this.attachWorkerSessionHooks(session, { manifest, task, repoRoot });
    }
    return result;
  }

  async messageWorker(params = {}) {
    if (!params.runId) throw new Error("runId is required for multitask message.");
    if (!params.taskId) throw new Error("taskId is required for multitask message.");
    if (params.message === undefined || params.message === null || params.message === "") throw new Error("message is required for multitask message.");
    const repoRoot = await this.resolveRepoRoot();
    const manifest = await loadManifest(repoRoot, params.runId);
    const task = taskById(manifest, params.taskId);
    if (!task) throw new Error(`No multitask task ${params.taskId} in run ${params.runId}.`);
    const envelope = normalizeSupervisorMessage(params.message, {
      runId: manifest.runId,
      taskId: task.id,
      mode: params.mode,
      type: params.type,
      correlationId: params.correlationId,
      payload: params.payload,
    });

    const result = await this.restartWorker({
      manifest,
      task,
      repoRoot,
      restartIfNeeded: params.restartIfNeeded === true,
      message: envelope.prompt,
      mode: envelope.mode,
      images: params.images,
    });

    if (!result.messageResult) {
      const suggestion = result.suggestion || formatRecoverySuggestions(result.classification || {});
      throw new Error(`Worker session ${manifest.runId}/${task.id} is not attached to this daemon. ${suggestion || "Use restartIfNeeded or /mt-resume to restart from the persisted session directory."}`);
    }

    await appendTaskEvent(repoRoot, manifest.runId, task.id, "worker_message_sent", {
      command: result.messageResult.command,
      mode: envelope.mode,
      type: envelope.type,
      correlationId: envelope.correlationId,
      isTyped: envelope.isTyped,
      restarted: result.restarted,
    });
    return {
      runId: manifest.runId,
      taskId: task.id,
      command: result.messageResult.command,
      mode: envelope.mode,
      type: envelope.type,
      correlationId: envelope.correlationId,
      response: result.messageResult.response,
      worker: result.worker || result.session?.getStatus?.(),
      restarted: result.restarted,
      recovery: result.classification,
      message: envelope.dto,
    };
  }

  async persistSchedulePlan(repoRoot, manifest, plan) {
    for (const update of plan.updates || []) {
      if (update.type !== "task_status_update") continue;
      const task = taskById(manifest, update.taskId);
      if (!task) continue;
      Object.assign(task, update.patch || {});
      await saveTaskState(repoRoot, manifest.runId, task);
    }
    manifest.status = inferRunStatusFromTasks(manifest.tasks || []);
    await saveManifest(repoRoot, manifest);
    for (const event of plan.events || []) {
      if (event.scope === "task") await appendTaskEvent(repoRoot, manifest.runId, event.taskId, event.type, event);
      else if (event.scope === "run") await appendRunEvent(repoRoot, manifest.runId, event.type, event);
    }
    return manifest;
  }

  async scheduleRun(runOrId, options = {}) {
    const repoRoot = options.repoRoot || await this.resolveRepoRoot();
    let manifest = typeof runOrId === "string" ? await loadManifest(repoRoot, runOrId) : runOrId;
    if (!manifest) return undefined;
    await applyRecoveryToManifest(repoRoot, manifest, {
      workerSessions: this,
      applyStatusChanges: true,
    });
    manifest = await loadManifest(repoRoot, manifest.runId).catch(() => manifest);
    const plan = planSchedule(manifest, { maxConcurrency: manifest.maxConcurrency });
    await this.persistSchedulePlan(repoRoot, manifest, plan);

    const started = [];
    const failures = [];
    await Promise.all((plan.startTaskIds || []).map(async (taskId) => {
      const latest = await loadManifest(repoRoot, manifest.runId).catch(() => manifest);
      const task = taskById(latest, taskId);
      if (!task) return;
      try {
        const worker = await this.startWorkerSession({ manifest: latest, task, repoRoot, config: options.config });
        started.push({ taskId, worker });
      } catch (error) {
        failures.push({ taskId, error: error.message });
        const failedManifest = await loadManifest(repoRoot, manifest.runId).catch(() => latest);
        const failedTask = taskById(failedManifest, taskId);
        if (failedTask) await setTaskStatus(repoRoot, failedManifest, failedTask, TASK_STATUS.FAILED, { error: error.message });
      }
    }));

    const latest = await loadManifest(repoRoot, manifest.runId).catch(() => manifest);
    latest.status = inferRunStatusFromTasks(latest.tasks || []);
    await saveManifest(repoRoot, latest);
    return { manifest: latest, plan, started, failures };
  }

  async queueSchedule(runId, options = {}) {
    const previous = this.schedulerQueue.get(runId) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.scheduleRun(runId, options));
    const tracked = next.finally(() => {
      if (this.schedulerQueue.get(runId) === tracked) this.schedulerQueue.delete(runId);
    });
    this.schedulerQueue.set(runId, tracked);
    return next;
  }

  async spawnIntoRun(params = {}) {
    const repoRoot = await this.resolveRepoRoot();
    const result = await spawnTasks(params, {
      cwd: repoRoot,
      repo: { root: repoRoot },
      ...this.spawnOptions,
    });
    const scheduled = await this.scheduleRun(result.manifest, { repoRoot });
    const manifest = scheduled?.manifest || await loadManifest(repoRoot, result.runId);
    return {
      ...result,
      manifest,
      schedule: scheduled?.plan,
      started: scheduled?.started || [],
      startFailures: scheduled?.failures || [],
      summary: `Spawned ${result.taskIds.length} task(s) into run ${result.runId}. ${scheduled?.started?.length || 0} started by scheduler, ${(scheduled?.failures || []).length} failed to start.`,
    };
  }

  async resumeWorker(params = {}) {
    if (!params.runId) throw new Error("runId is required for multitask resume.");
    const repoRoot = await this.resolveRepoRoot();
    const manifest = await loadManifest(repoRoot, params.runId);
    const tasks = params.taskId ? [taskById(manifest, params.taskId)] : (manifest.tasks || []);
    if (tasks.some((task) => !task)) throw new Error(`No multitask task ${params.taskId} in run ${params.runId}.`);
    if (params.message && !params.taskId) throw new Error("taskId is required when resuming with a message.");

    const results = [];
    for (const task of tasks) {
      const envelope = params.message === undefined ? undefined : normalizeSupervisorMessage(params.message, {
        runId: manifest.runId,
        taskId: task.id,
        mode: params.mode,
        type: params.type,
        correlationId: params.correlationId,
        payload: params.payload,
      });
      const result = await this.restartWorker({
        manifest,
        task,
        repoRoot,
        restartIfNeeded: true,
        message: envelope?.prompt,
        mode: envelope?.mode || params.mode,
        images: params.images,
      }).catch((error) => ({ runId: manifest.runId, taskId: task.id, error: error.message, classification: error.classification }));
      results.push(result);
    }
    return {
      runId: manifest.runId,
      taskId: params.taskId,
      results,
      summary: `Resume ${manifest.runId}${params.taskId ? `/${params.taskId}` : ""}: ${results.filter((result) => result.restarted).length} restarted, ${results.filter((result) => result.error).length} failed.`,
    };
  }

  async listAgentDefinitions(params = {}) {
    const repoRoot = await this.resolveRepoRoot();
    const agents = await listAgents({
      repoRoot,
      packageRoot: path.resolve(__dirname, "../.."),
      ...(this.workerSessionOptions.agentOptions || {}),
    });
    const includeProject = params.includeProject !== false;
    const filtered = includeProject ? agents : agents.filter((agent) => !["project", "legacy-project"].includes(agent.source));
    return {
      agents: filtered.map((agent) => ({
        name: agent.name,
        description: agent.description,
        source: agent.source,
        file: agent.file,
        model: agent.model,
        thinking: agent.thinking,
        tools: agent.tools,
        skills: agent.skills,
        systemPromptMode: agent.systemPromptMode,
        inheritProjectContext: agent.inheritProjectContext,
        maxTurns: agent.maxTurns,
        hash: agent.hash,
        projectLocal: ["project", "legacy-project"].includes(agent.source),
      })),
      summary: filtered.length ? filtered.map((agent) => `${agent.name} (${agent.source})${agent.description ? ` — ${agent.description}` : ""}`).join("\n") : "No multitask agents found.",
    };
  }

  async abortWorkerSessions(params = {}) {
    if (!params.runId) return;
    const repoRoot = await this.resolveRepoRoot();
    const manifest = await loadManifest(repoRoot, params.runId).catch(() => undefined);
    const taskIds = params.taskId
      ? [params.taskId]
      : (manifest?.tasks || []).map((task) => task.id);
    for (const taskId of taskIds) {
      const session = this.getWorkerSession(params.runId, taskId);
      if (!session?.isAlive) continue;
      await session.stop({ timeoutMs: 10_000 }).catch((error) => appendTaskEvent(repoRoot, params.runId, taskId, "worker_abort_failed", { error: error.message }));
    }
  }

  async normalizeRunReferenceParams(method, params = {}) {
    if (!params || !params.runId || !RUN_REFERENCE_METHODS.has(method)) return params || {};
    const repoRoot = await this.resolveRepoRoot();
    const runId = await resolveRunId(repoRoot, params.runId);
    if (runId === params.runId) return params;
    return { ...params, requestedRunId: params.runId, runId };
  }

  async dispatch(method, params) {
    const custom = this.handlers.get(method);
    if (custom) return custom(params, this);
    params = await this.normalizeRunReferenceParams(method, params || {});

    switch (method) {
      case METHODS.PING: {
        const repoRoot = await this.resolveRepoRoot();
        const daemonStatus = await getDaemonStatus(repoRoot, { socketPath: await this.resolveSocketPath() }).catch(() => undefined);
        return { ok: true, pid: process.pid, repoRoot, daemonStatus, summary: daemonStatus ? formatDaemonStatus(daemonStatus) : undefined };
      }
      case METHODS.START:
        return startRun(params, {
          cwd: await this.resolveRepoRoot(),
          scheduler: (manifest) => this.scheduleRun(manifest),
        });
      case METHODS.STATUS: {
        const repoRoot = await this.resolveRepoRoot();
        return getStatus(params, { cwd: repoRoot, repo: { root: repoRoot }, workerSessions: this, applyRecovery: true });
      }
      case METHODS.LOGS:
        return getLogs(params, { cwd: await this.resolveRepoRoot() });
      case METHODS.CANCEL:
        await this.abortWorkerSessions(params).catch(() => {});
        return cancelRun(params, { cwd: await this.resolveRepoRoot() });
      case METHODS.MESSAGE:
        return this.messageWorker(params);
      case METHODS.DIFF:
        return getDiff(params, { cwd: await this.resolveRepoRoot() });
      case METHODS.REVIEW:
        return reviewTasks(params, { cwd: await this.resolveRepoRoot() });
      case METHODS.MERGE:
        return mergeTasks(params, { cwd: await this.resolveRepoRoot() });
      case METHODS.APPLY:
        return applyIntegration(params, { cwd: await this.resolveRepoRoot() });
      case METHODS.CLEANUP:
        await this.abortWorkerSessions(params).catch(() => {});
        return cleanupMultitaskRun(params, { cwd: await this.resolveRepoRoot() });
      case METHODS.SPAWN:
        return this.spawnIntoRun(params);
      case METHODS.RESUME:
        return this.resumeWorker(params);
      case METHODS.AGENTS:
        return this.listAgentDefinitions(params);
      case METHODS.DOCTOR: {
        const report = await runDoctor(params, { cwd: await this.resolveRepoRoot(), workerSessions: this });
        return { ...report, formatted: formatDoctorReport(report) };
      }
      case METHODS.EXPORT: {
        const bundle = await exportMultitaskRun(params, { cwd: await this.resolveRepoRoot() });
        return compactRunExportResult(bundle);
      }
      case METHODS.PRUNE: {
        const result = await pruneMultitask(params, { cwd: await this.resolveRepoRoot() });
        return { ...result, formatted: summarizePruneResult(result) };
      }
      case METHODS.SHUTDOWN:
        return { ok: true };
      default:
        throw new Error(`Unknown multitask daemon method: ${method}`);
    }
  }
}

function createDaemon(options = {}) {
  return new MultitaskDaemon(options);
}

module.exports = {
  MultitaskDaemon,
  cancelRun,
  createDaemon,
  createIntegrationWorktree,
  createLocalRun,
  createTaskWorktree,
  getDiff,
  getLogs,
  getStatus,
  reviewTasks,
  mergeTasks,
  applyIntegration,
  cleanupMultitaskRun,
  getDaemonStatus,
  formatDaemonStatus,
  setRunStatus,
  setTaskStatus,
  setupRunWorktrees,
  startRun,
};
