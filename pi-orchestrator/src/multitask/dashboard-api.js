const { loadConfig } = require("../config.js");
const { getRepoInfo } = require("../git.js");
const { fsp, path, pathExists, slugify, truncateMiddle } = require("../utils.js");
const { createClient } = require("./client.js");
const { getDiff } = require("./diff.js");
const { getStatus } = require("./daemon.js");
const { runDoctor, formatDoctorReport } = require("./doctor.js");
const { listAgents } = require("./agents.js");
const {
  loadManifest,
  resolveRunId,
  runEventsPath,
  taskEventsPath,
  taskReviewPath,
  taskTranscriptPath,
} = require("./manifest.js");
const { createTuiState, normalizeRun } = require("./tui-state.js");

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DEFAULT_DIFF_FILE_LIMIT = 50;
const MAX_DIFF_FILE_LIMIT = 200;
const DEFAULT_TEXT_BYTES = 32 * 1024;
const DEFAULT_JSONL_TAIL_BYTES = 256 * 1024;
const DEFAULT_ENTRY_BYTES = 16 * 1024;
const MAX_MESSAGE_BYTES = 32 * 1024;
const DASHBOARD_MESSAGE_MODES = new Set(["followUp", "steer"]);
const DASHBOARD_MESSAGE_TYPES = new Set(["assignment", "question", "inform", "review_feedback", "decision"]);
const RUN_MESSAGE_SCOPES = new Set(["running", "attention", "ready", "active", "all"]);
const TERMINAL_TASK_STATUS_SET = new Set(["merged", "failed", "aborted", "cancelled"]);
const ATTENTION_TASK_STATUS_SET = new Set(["blocked", "needs_attention", "needs_changes"]);
const READY_TASK_STATUS_SET = new Set(["ready_for_review", "ready_to_merge"]);
const RUNNING_TASK_STATUS_SET = new Set(["running", "idle"]);

function clampInteger(value, fallback, max = MAX_LIMIT) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), max);
}

function truncateText(value, maxBytes = DEFAULT_TEXT_BYTES) {
  const text = String(value || "");
  const truncated = truncateMiddle(text, maxBytes);
  return {
    text: truncated,
    truncated: truncated !== text,
    bytes: Buffer.byteLength(text, "utf8"),
    maxBytes,
  };
}

function publicError(error) {
  return {
    message: error?.message || String(error || "Unknown Porchestrator dashboard error."),
    code: error?.code,
  };
}

function asRuns(status) {
  if (Array.isArray(status?.runs)) return status.runs;
  if (status?.manifest) return [status.manifest];
  return [];
}

function createStatusEnvelope(status, extra = {}) {
  const state = createTuiState({
    runs: asRuns(status),
    activeRunId: status?.activeRunId,
    daemonStatus: status?.daemonStatus,
    generatedAt: status?.generatedAt,
  });
  return {
    kind: "pi-multitask-dashboard-status",
    generatedAt: new Date().toISOString(),
    activeRunId: status?.activeRunId || state.activeRunId || state.activeRuns?.[0]?.runId,
    summary: truncateText(status?.summary || "", 16 * 1024),
    daemonStatus: status?.daemonStatus,
    totals: state.totals,
    runs: state.runs.map(compactRun),
    recoveries: status?.recoveries,
    ...extra,
  };
}

function compactRun(run) {
  return {
    kind: "pi-multitask-dashboard-run-summary",
    runId: run?.runId,
    id: run?.id || run?.runId,
    runName: run?.runName,
    displayName: run?.displayName || run?.runName || run?.runId,
    status: run?.status,
    statusLabel: run?.statusLabel,
    compactStatusLabel: run?.compactStatusLabel,
    active: run?.active,
    createdAt: run?.createdAt,
    updatedAt: run?.updatedAt,
    baseRef: run?.baseRef,
    baseCommit: run?.baseCommit,
    baseBranch: run?.baseBranch,
    repoRoot: run?.repoRoot,
    stateDir: run?.stateDir,
    worktreeRoot: run?.worktreeRoot,
    maxConcurrency: run?.maxConcurrency,
    taskCounts: run?.taskCounts,
    boardCounts: run?.boardCounts,
    queuedTaskCount: run?.queuedTaskCount,
    runningTaskCount: run?.runningTaskCount,
    attentionTaskCount: run?.attentionTaskCount,
    readyTaskCount: run?.readyTaskCount,
    activeTaskCount: run?.activeTaskCount,
    integration: run?.integration ? {
      id: run.integration.id,
      status: run.integration.status,
      branch: run.integration.branch,
      worktree: run.integration.worktree,
      updatedAt: run.integration.updatedAt,
      error: run.integration.error,
      validation: Array.isArray(run.integration.validation) ? run.integration.validation.slice(-5).map((entry) => boundJsonEntry(entry)) : undefined,
    } : undefined,
    tasks: (run?.tasks || []).map((task) => compactTask(task, run)),
  };
}

function compactTask(task, run) {
  return {
    runId: run?.runId || task?.runId,
    taskId: task?.id || task?.taskId,
    id: task?.id || task?.taskId,
    title: task?.title,
    status: task?.status,
    statusLabel: task?.statusLabel,
    compactStatusLabel: task?.compactStatusLabel,
    statusCategory: task?.statusCategory,
    attention: task?.attention,
    ready: task?.ready,
    queued: task?.queued,
    running: task?.running,
    active: task?.active,
    agent: task?.agent,
    model: task?.model,
    branch: task?.branch,
    worktree: task?.worktree,
    dependencies: task?.dependencies || [],
    blockedBy: task?.blockedBy || [],
    worker: task?.worker ? {
      attachmentState: task.worker.attachmentState,
      activityStatus: task.worker.activityStatus,
      processStatus: task.worker.processStatus,
      pid: task.worker.pid,
      sessionDir: task.worker.sessionDir,
      recoveryReason: task.worker.recoveryReason,
      recoveryAction: task.worker.recoveryAction,
    } : undefined,
    workerActivity: task?.workerActivity,
    workerAttachment: task?.workerAttachment,
    changedFilesText: task?.changedFilesText,
    review: task?.review ? boundJsonEntry(task.review, { maxEntryBytes: 4096 }) : undefined,
    validation: Array.isArray(task?.validation) ? task.validation.slice(-5).map((entry) => boundJsonEntry(entry, { maxEntryBytes: 4096 })) : undefined,
    lastMessageAt: task?.lastMessageAt,
    createdAt: task?.createdAt,
    updatedAt: task?.updatedAt,
    startedAt: task?.startedAt,
    completedAt: task?.completedAt,
    recovery: task?.recovery ? boundJsonEntry(task.recovery, { maxEntryBytes: 4096 }) : undefined,
    error: task?.error ? truncateText(task.error, 4096).text : undefined,
  };
}

function findTask(manifest, taskId) {
  const requested = String(taskId || "");
  const normalized = slugify(requested, "task");
  return (manifest.tasks || []).find((task) => task.id === requested || task.id === normalized || task.taskId === requested);
}

function boundedDiffPayload(diff, options = {}) {
  const maxFiles = clampInteger(options.maxFiles, DEFAULT_DIFF_FILE_LIMIT, MAX_DIFF_FILE_LIMIT);
  const changedFiles = Array.isArray(diff.changedFiles) ? diff.changedFiles.slice(0, maxFiles) : [];
  const targets = Array.isArray(diff.targets)
    ? diff.targets.map((target) => boundedDiffPayload(target, options))
    : undefined;
  return {
    runId: diff.runId,
    targetId: diff.targetId,
    targetType: diff.targetType,
    baseRef: diff.baseRef,
    head: diff.head,
    branch: diff.branch,
    worktree: diff.worktree,
    branchExists: diff.branchExists,
    worktreeExists: diff.worktreeExists,
    changedFiles,
    changedFileCount: Array.isArray(diff.changedFiles) ? diff.changedFiles.length : changedFiles.length,
    changedFilesTruncated: Array.isArray(diff.changedFiles) && diff.changedFiles.length > changedFiles.length,
    committed: diff.committed ? {
      shortstat: diff.committed.shortstat,
      stat: truncateText(diff.committed.stat, options.maxBytes || DEFAULT_TEXT_BYTES),
    } : undefined,
    workingTree: diff.workingTree ? {
      shortstat: diff.workingTree.shortstat,
      stat: truncateText(diff.workingTree.stat, options.maxBytes || DEFAULT_TEXT_BYTES),
      status: Array.isArray(diff.workingTree.status) ? diff.workingTree.status.slice(0, maxFiles) : [],
    } : undefined,
    unmergedFiles: Array.isArray(diff.unmergedFiles) ? diff.unmergedFiles.slice(0, maxFiles) : [],
    errors: diff.errors || [],
    summary: truncateText(diff.summary, options.maxBytes || DEFAULT_TEXT_BYTES),
    targets,
  };
}

async function readOptionalText(file, options = {}) {
  if (!(await pathExists(file))) return undefined;
  const raw = await fsp.readFile(file, "utf8");
  return truncateText(raw, options.maxBytes || DEFAULT_TEXT_BYTES);
}

function parseJsonLine(line, source) {
  try {
    return JSON.parse(line);
  } catch (error) {
    return { type: "malformed_event", source, raw: truncateText(line, 4096), error: error.message };
  }
}

function boundJsonEntry(entry, options = {}) {
  const maxBytes = options.maxEntryBytes || DEFAULT_ENTRY_BYTES;
  const raw = JSON.stringify(entry);
  if (Buffer.byteLength(raw, "utf8") <= maxBytes) return entry;
  return {
    time: entry?.time,
    type: entry?.type || entry?.role || "large_entry",
    runId: entry?.runId,
    taskId: entry?.taskId,
    scope: entry?.scope,
    truncated: true,
    raw: truncateText(raw, maxBytes),
  };
}

async function readJsonLinesTailBounded(file, options = {}) {
  const limit = clampInteger(options.limit || options.lines, DEFAULT_LIMIT, MAX_LIMIT);
  const maxBytes = clampInteger(options.maxBytes, DEFAULT_JSONL_TAIL_BYTES, 1024 * 1024);
  if (!(await pathExists(file))) return { entries: [], limit, bytesRead: 0, truncated: false };
  const stat = await fsp.stat(file);
  const bytesToRead = Math.min(stat.size, maxBytes);
  const start = Math.max(0, stat.size - bytesToRead);
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, start);
    let text = buffer.toString("utf8");
    const truncated = start > 0;
    if (truncated) text = text.replace(/^[^\n]*(\n|$)/, "");
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    const selected = lines.slice(-limit);
    return {
      entries: selected.map((line) => boundJsonEntry(parseJsonLine(line, file), options)),
      limit,
      bytesRead: bytesToRead,
      truncated: truncated || lines.length > selected.length,
    };
  } finally {
    await handle.close();
  }
}

function bodyByteLength(value) {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value ?? {}), "utf8");
}

function messageTextFromInput(message) {
  if (typeof message === "string") return message;
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const text = message.message ?? message.text ?? message.summary;
    if (typeof text === "string") return text;
  }
  return undefined;
}

function normalizeDashboardMessageInput(input = {}) {
  const objectInput = input && typeof input === "object" && !Array.isArray(input) ? input : undefined;
  const envelope = objectInput || { message: input };
  const rawMessage = envelope.message !== undefined ? envelope.message : envelope.text !== undefined ? envelope.text : input;
  const text = messageTextFromInput(rawMessage);
  if (typeof text !== "string" || !text.trim()) throw new Error("Message text is required.");
  if (bodyByteLength(text) > MAX_MESSAGE_BYTES) throw new Error(`Message is too large. Limit is ${MAX_MESSAGE_BYTES} bytes.`);
  const mode = envelope.mode;
  const type = envelope.type;
  if (mode !== undefined && !DASHBOARD_MESSAGE_MODES.has(mode)) throw new Error(`Unsupported message mode ${mode}.`);
  if (type !== undefined && !DASHBOARD_MESSAGE_TYPES.has(type)) throw new Error(`Unsupported message type ${type}.`);
  const hasTypedMetadata = Boolean(type && type !== "inform") || envelope.correlationId !== undefined || envelope.payload !== undefined || (rawMessage && typeof rawMessage === "object");
  const params = {
    message: hasTypedMetadata
      ? {
          ...(rawMessage && typeof rawMessage === "object" && !Array.isArray(rawMessage) ? rawMessage : {}),
          message: text,
          ...(mode !== undefined ? { mode } : {}),
          ...(type !== undefined ? { type } : {}),
          ...(envelope.correlationId !== undefined ? { correlationId: String(envelope.correlationId) } : {}),
          ...(envelope.payload !== undefined ? { payload: envelope.payload } : {}),
        }
      : text,
  };
  if (mode !== undefined) params.mode = mode;
  if (type !== undefined) params.type = type;
  if (envelope.correlationId !== undefined) params.correlationId = String(envelope.correlationId);
  if (envelope.payload !== undefined) {
    if (bodyByteLength(envelope.payload) > MAX_MESSAGE_BYTES) throw new Error(`Message payload is too large. Limit is ${MAX_MESSAGE_BYTES} bytes.`);
    params.payload = envelope.payload;
  }
  if (envelope.restartIfNeeded === true) params.restartIfNeeded = true;
  return params;
}

function compactMessageResult(result = {}) {
  return {
    runId: result.runId,
    taskId: result.taskId,
    command: result.command,
    mode: result.mode,
    type: result.type,
    correlationId: result.correlationId,
    restarted: result.restarted,
    worker: result.worker ? {
      attachmentState: result.worker.attachmentState,
      activityStatus: result.worker.activityStatus,
      processStatus: result.worker.processStatus,
      pid: result.worker.pid,
      sessionDir: result.worker.sessionDir,
    } : undefined,
    recovery: result.recovery ? boundJsonEntry(result.recovery, { maxEntryBytes: 4096 }) : undefined,
    message: result.message ? boundJsonEntry(result.message, { maxEntryBytes: 4096 }) : undefined,
  };
}

function taskMatchesMessageScope(task = {}, scope = "running") {
  const status = String(task.status || "");
  if (scope === "all") return !TERMINAL_TASK_STATUS_SET.has(status);
  if (scope === "active") return !TERMINAL_TASK_STATUS_SET.has(status);
  if (scope === "running") return RUNNING_TASK_STATUS_SET.has(status);
  if (scope === "attention") return ATTENTION_TASK_STATUS_SET.has(status);
  if (scope === "ready") return READY_TASK_STATUS_SET.has(status);
  return false;
}

function sanitizeConfig(config) {
  return {
    path: config.path,
    worktrees: config.worktrees,
    defaults: config.defaults,
    workers: config.workers,
    scripts: Object.fromEntries(Object.entries(config.scripts || {}).map(([id, script]) => [id, {
      id,
      name: script.name,
      description: script.description,
      command: script.command,
      cwd: script.cwd,
      timeoutSeconds: script.timeoutSeconds,
      required: script.required,
    }])),
    validation: config.validation,
  };
}

class DashboardApi {
  constructor(options = {}) {
    this.cwd = options.cwd || process.cwd();
    this.repoRoot = options.repoRoot;
    this.client = options.client;
    this.clientFactory = options.clientFactory || ((clientOptions) => createClient(clientOptions));
    this.packageRoot = options.packageRoot || path.resolve(__dirname, "../..");
  }

  async resolveRepoRoot() {
    if (this.repoRoot) return this.repoRoot;
    const repo = await getRepoInfo(this.cwd);
    this.repoRoot = repo.root;
    return this.repoRoot;
  }

  async getClient() {
    if (this.client) return this.client;
    const repoRoot = await this.resolveRepoRoot();
    this.client = this.clientFactory({ cwd: this.cwd, repoRoot });
    return this.client;
  }

  async daemonCall(method, params = {}) {
    const client = await this.getClient();
    if (typeof client[method] !== "function") throw new Error(`Dashboard client does not support ${method}.`);
    return client[method](params);
  }

  async status(params = {}) {
    try {
      const status = await this.daemonCall("status", params);
      return createStatusEnvelope(status, { source: "daemon" });
    } catch (error) {
      const repoRoot = await this.resolveRepoRoot();
      const fallbackParams = params.runId ? { ...params, runId: await resolveRunId(repoRoot, params.runId) } : params;
      const fallback = await getStatus(fallbackParams, {
        cwd: repoRoot,
        repo: { root: repoRoot },
        includeRecovery: false,
      });
      return createStatusEnvelope(fallback, {
        source: "local-state",
        warnings: [`Daemon unavailable; showing persisted state only. ${error.message}`],
      });
    }
  }

  async runs() {
    return this.status({});
  }

  async run(runId) {
    const status = await this.status({ runId });
    const run = status.runs.find((candidate) => candidate.runId === (status.activeRunId || runId)) || status.runs[0];
    if (!run) throw new Error(`No Porchestrator run found for ${runId}.`);
    let events = [];
    try {
      events = (await this.events(run.runId, { limit: 50 })).events;
    } catch {}
    return { ...run, recentEvents: events };
  }

  async events(runId, params = {}) {
    const repoRoot = await this.resolveRepoRoot();
    const resolvedRunId = await resolveRunId(repoRoot, runId);
    const limit = clampInteger(params.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const result = await readJsonLinesTailBounded(runEventsPath(repoRoot, resolvedRunId), { limit });
    return { runId: resolvedRunId, limit, events: result.entries, truncated: result.truncated, bytesRead: result.bytesRead, source: "local-state" };
  }

  async task(runId, taskId) {
    const repoRoot = await this.resolveRepoRoot();
    const manifest = await loadManifest(repoRoot, await resolveRunId(repoRoot, runId));
    const task = findTask(manifest, taskId);
    if (!task) throw new Error(`No Porchestrator task ${taskId} in run ${manifest.runId}.`);
    const [logs, diff] = await Promise.all([
      this.taskLogs(manifest.runId, task.id, { limit: 20 }).catch((error) => ({ error: publicError(error), events: [], transcript: [] })),
      this.diff(manifest.runId, task.id, { maxFiles: 50 }).catch((error) => ({ error: publicError(error) })),
    ]);
    return {
      ...compactTask(task, manifest),
      assignment: {
        summary: task.title || task.id,
        promptTail: truncateText(task.prompt || "", 16 * 1024),
      },
      branch: task.branch,
      worktree: task.worktree,
      sessionDir: task.paths?.session || task.worker?.sessionDir,
      paths: task.paths,
      dependencies: task.dependencies || [],
      blockedBy: task.blockedBy || [],
      counts: {
        events: logs.events?.length || 0,
        transcriptEntries: logs.transcript?.length || 0,
        changedFiles: diff.changedFileCount || diff.changedFiles?.length || 0,
      },
      lastEvent: logs.events?.[logs.events.length - 1],
      recentEvents: logs.events || [],
      transcriptTail: logs.transcript || [],
      diff,
      validation: task.validation || [],
      review: task.review,
      recovery: task.recovery || task.worker?.recovery,
    };
  }

  async taskLogs(runId, taskId, params = {}) {
    const repoRoot = await this.resolveRepoRoot();
    const resolvedRunId = await resolveRunId(repoRoot, runId);
    const manifest = await loadManifest(repoRoot, resolvedRunId);
    const task = findTask(manifest, taskId);
    if (!task) throw new Error(`No Porchestrator task ${taskId} in run ${resolvedRunId}.`);
    const limit = clampInteger(params.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const [events, transcript] = await Promise.all([
      readJsonLinesTailBounded(taskEventsPath(repoRoot, resolvedRunId, task.id), { limit }),
      readJsonLinesTailBounded(taskTranscriptPath(repoRoot, resolvedRunId, task.id), { limit }),
    ]);
    return {
      runId: resolvedRunId,
      taskId: task.id,
      limit,
      events: events.entries,
      transcript: transcript.entries,
      eventsTruncated: events.truncated,
      transcriptTruncated: transcript.truncated,
      bytesRead: { events: events.bytesRead, transcript: transcript.bytesRead },
      source: "local-state",
    };
  }

  async transcript(runId, taskId, params = {}) {
    const logs = await this.taskLogs(runId, taskId, params);
    return {
      runId: logs.runId,
      taskId: logs.taskId,
      limit: logs.limit,
      entries: logs.transcript || [],
      count: logs.transcript?.length || 0,
      truncated: logs.transcriptTruncated,
      bytesRead: logs.bytesRead?.transcript,
      source: logs.source,
      warning: logs.warning,
    };
  }

  async diff(runId, taskId, params = {}) {
    const maxFiles = clampInteger(params.maxFiles, DEFAULT_DIFF_FILE_LIMIT, MAX_DIFF_FILE_LIMIT);
    try {
      const result = await this.daemonCall("diff", { runId, taskId, maxFiles });
      return boundedDiffPayload(result, { maxFiles });
    } catch (error) {
      const repoRoot = await this.resolveRepoRoot();
      const result = await getDiff({ runId, taskId, maxFiles }, { cwd: repoRoot, repo: { root: repoRoot } });
      return { ...boundedDiffPayload(result, { maxFiles }), source: "local-state", warning: error.message };
    }
  }

  async review(runId) {
    const repoRoot = await this.resolveRepoRoot();
    const manifest = await loadManifest(repoRoot, await resolveRunId(repoRoot, runId));
    const tasks = await Promise.all((manifest.tasks || []).map(async (task) => ({
      runId: manifest.runId,
      taskId: task.id,
      status: task.status,
      review: task.review,
      reviewMarkdown: await readOptionalText(taskReviewPath(repoRoot, manifest.runId, task.id), { maxBytes: 16 * 1024 }),
    })));
    return { runId: manifest.runId, tasks };
  }

  async integration(runId) {
    const repoRoot = await this.resolveRepoRoot();
    const manifest = await loadManifest(repoRoot, await resolveRunId(repoRoot, runId));
    const integration = manifest.integration;
    let diff;
    if (integration) {
      diff = await this.daemonCall("diff", { runId: manifest.runId, integration: true })
        .then((result) => boundedDiffPayload(result, { maxFiles: DEFAULT_DIFF_FILE_LIMIT }))
        .catch(async (error) => {
          const result = await getDiff({ runId: manifest.runId, integration: true }, { cwd: repoRoot, repo: { root: repoRoot } });
          return { ...boundedDiffPayload(result, { maxFiles: DEFAULT_DIFF_FILE_LIMIT }), source: "local-state", warning: error.message };
        });
    }
    return {
      runId: manifest.runId,
      integration,
      validation: integration?.validation || [],
      startupResults: integration?.startupResults || [],
      diff,
    };
  }

  async messageTask(runId, taskId, input = {}) {
    const messageParams = normalizeDashboardMessageInput(input);
    if (messageParams.restartIfNeeded === true) {
      const repoRoot = await this.resolveRepoRoot();
      const manifest = await loadManifest(repoRoot, await resolveRunId(repoRoot, runId));
      const task = findTask(manifest, taskId);
      if (!task) throw new Error(`No Porchestrator task ${taskId} in run ${manifest.runId}.`);
      if (TERMINAL_TASK_STATUS_SET.has(String(task.status || "")) || task.worker?.attachmentState === "completed") {
        throw new Error(`Dashboard restartIfNeeded is not allowed for terminal/completed task ${manifest.runId}/${task.id}.`);
      }
    }
    const result = await this.daemonCall("message", { runId, taskId, ...messageParams });
    return {
      kind: "pi-multitask-dashboard-message-result",
      ok: true,
      result: compactMessageResult(result),
      summary: `Sent ${result.command || "message"} to ${result.runId}/${result.taskId}.`,
    };
  }

  async messageRun(runId, input = {}) {
    const objectInput = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const scope = objectInput.scope || "running";
    if (!RUN_MESSAGE_SCOPES.has(scope)) throw new Error(`Unsupported run message scope ${scope}.`);
    const repoRoot = await this.resolveRepoRoot();
    const resolvedRunId = await resolveRunId(repoRoot, runId);
    const manifest = await loadManifest(repoRoot, resolvedRunId);
    let taskIds = Array.isArray(objectInput.taskIds) ? objectInput.taskIds.map(String).filter(Boolean) : [];
    if (!taskIds.length) {
      taskIds = (manifest.tasks || [])
        .filter((task) => taskMatchesMessageScope(task, scope))
        .map((task) => task.id);
    }
    taskIds = [...new Set(taskIds)];
    if (!taskIds.length) throw new Error(`No tasks matched run message scope ${scope}.`);

    const results = [];
    for (const taskId of taskIds) {
      const task = findTask(manifest, taskId);
      if (!task) {
        results.push({ taskId, ok: false, error: `No Porchestrator task ${taskId} in run ${resolvedRunId}.` });
        continue;
      }
      try {
        const sent = await this.messageTask(resolvedRunId, task.id, input);
        results.push({ taskId: task.id, ok: true, result: sent.result });
      } catch (error) {
        results.push({ taskId: task.id, ok: false, error: error.message });
      }
    }
    const sentCount = results.filter((result) => result.ok).length;
    return {
      kind: "pi-multitask-dashboard-run-message-result",
      ok: sentCount === results.length,
      runId: resolvedRunId,
      scope,
      requestedTaskIds: taskIds,
      sentCount,
      failedCount: results.length - sentCount,
      results,
      summary: `Sent message to ${sentCount}/${results.length} task(s) in ${resolvedRunId}.`,
    };
  }

  async doctor(params = {}) {
    try {
      return await this.daemonCall("doctor", params);
    } catch (error) {
      const repoRoot = await this.resolveRepoRoot();
      const report = await runDoctor(params, { cwd: repoRoot });
      return { ...report, formatted: formatDoctorReport(report), source: "local-state", warning: error.message };
    }
  }

  async agents(params = {}) {
    try {
      return await this.daemonCall("agents", { includeProject: true, ...params });
    } catch (error) {
      const repoRoot = await this.resolveRepoRoot();
      const agents = await listAgents({ repoRoot, packageRoot: this.packageRoot });
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
          trusted: !["project", "legacy-project"].includes(agent.source),
          trustReason: ["project", "legacy-project"].includes(agent.source) ? "not_trusted_by_viewing_dashboard" : "not_project_local",
        })),
        summary: filtered.length ? filtered.map((agent) => `${agent.name} (${agent.source})`).join("\n") : "No multitask agents found.",
        source: "local-state",
        warning: error.message,
      };
    }
  }

  async config() {
    const repoRoot = await this.resolveRepoRoot();
    const config = await loadConfig(repoRoot);
    return sanitizeConfig(config);
  }
}

function createDashboardApi(options = {}) {
  return new DashboardApi(options);
}

module.exports = {
  DashboardApi,
  MAX_DIFF_FILE_LIMIT,
  MAX_LIMIT,
  boundJsonEntry,
  boundedDiffPayload,
  clampInteger,
  createDashboardApi,
  createStatusEnvelope,
  normalizeDashboardMessageInput,
  publicError,
  readJsonLinesTailBounded,
  sanitizeConfig,
  taskMatchesMessageScope,
  truncateText,
};
