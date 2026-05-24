const net = require("node:net");
const { loadConfig } = require("../config.js");
const { createWorktree, getRepoInfo } = require("../git.js");
const { runStartupScripts } = require("../hooks.js");
const { ensureDir, fsp, path, pathExists } = require("../utils.js");
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
      if (typeof context.workerStarter === "function") {
        await setTaskStatus(repoRoot, manifest, task, "running", { startedAt: new Date().toISOString() });
        await context.workerStarter({ manifest, task, repoRoot, config });
      } else {
        await setTaskStatus(repoRoot, manifest, task, "queued", {
          note: "Worker session startup is reserved for Phase 2.",
        });
        await appendTaskEvent(repoRoot, manifest.runId, task.id, "worker_start_pending", {
          reason: "Pi RPC worker sessions are implemented in Phase 2.",
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

  const latestManifest = await loadManifest(repoRoot, manifest.runId).catch(() => manifest);
  const failed = (latestManifest.tasks || []).filter((task) => task.status === "failed");
  const running = (latestManifest.tasks || []).filter((task) => task.status === "running");
  const finalStatus = failed.length > 0 ? "needs_attention" : running.length > 0 ? "running" : "idle";
  await setRunStatus(repoRoot, latestManifest, finalStatus, { setupCompletedAt: new Date().toISOString() });
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
  if (input.runId) {
    const manifest = await loadManifest(repo.root, input.runId);
    return { manifest, daemonStatus, summary: [summarizeRun(manifest), daemonStatus ? formatDaemonStatus(daemonStatus) : undefined].filter(Boolean).join("\n") };
  }
  const runs = await listRuns(repo.root);
  return {
    runs,
    daemonStatus,
    summary: [
      runs.length ? runs.map(summarizeRun).join("\n") : "No multitask runs found.",
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

  async startWorkerSession(context) {
    const { manifest, task, repoRoot } = context;
    const key = workerSessionKey(manifest.runId, task.id);
    const existing = this.workerSessions.get(key);
    if (existing?.isAlive) return existing.getStatus();
    const session = await createWorkerSessionForTask({ manifest, task, repoRoot }, this.workerSessionOptions);
    this.workerSessions.set(key, session);
    session.once("exit", () => this.workerSessions.delete(key));
    try {
      await session.start();
      if (this.workerSessionOptions.sendInitialPrompt !== false) {
        await session.prompt(task.prompt, { timeoutMs: this.workerSessionOptions.initialPromptTimeoutMs || session.responseTimeoutMs });
      }
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

  async messageWorker(params = {}) {
    if (!params.runId) throw new Error("runId is required for multitask message.");
    if (!params.taskId) throw new Error("taskId is required for multitask message.");
    if (!params.message || typeof params.message !== "string") throw new Error("message is required for multitask message.");
    const repoRoot = await this.resolveRepoRoot();
    const manifest = await loadManifest(repoRoot, params.runId);
    const key = workerSessionKey(manifest.runId, params.taskId);
    const task = (manifest.tasks || []).find((candidate) => workerSessionKey(manifest.runId, candidate.id) === key);
    if (!task) throw new Error(`No multitask task ${params.taskId} in run ${params.runId}.`);
    const session = this.workerSessions.get(key);
    if (!session?.isAlive) {
      throw new Error(`Worker session ${manifest.runId}/${task.id} is not attached to this daemon. Restart/resume is reserved for a later phase.`);
    }
    const result = await sendWorkerMessage(session, params.message, { mode: params.mode, images: params.images });
    await appendTaskEvent(repoRoot, manifest.runId, task.id, "worker_message_sent", {
      command: result.command,
      mode: params.mode,
    });
    return {
      runId: manifest.runId,
      taskId: task.id,
      command: result.command,
      response: result.response,
      worker: session.getStatus(),
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

  async dispatch(method, params) {
    const custom = this.handlers.get(method);
    if (custom) return custom(params, this);

    switch (method) {
      case METHODS.PING: {
        const repoRoot = await this.resolveRepoRoot();
        const daemonStatus = await getDaemonStatus(repoRoot, { socketPath: await this.resolveSocketPath() }).catch(() => undefined);
        return { ok: true, pid: process.pid, repoRoot, daemonStatus, summary: daemonStatus ? formatDaemonStatus(daemonStatus) : undefined };
      }
      case METHODS.START:
        return startRun(params, {
          cwd: await this.resolveRepoRoot(),
          workerStarter: (context) => this.startWorkerSession(context),
        });
      case METHODS.STATUS:
        return getStatus(params, { cwd: await this.resolveRepoRoot() });
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
        throw new Error(`${method} is a protocol placeholder implemented in a later phase.`);
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
