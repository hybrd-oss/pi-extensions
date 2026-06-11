const { spawn } = require("node:child_process");
const EventEmitter = require("node:events");
const { ensureDir, fs, fsp, path, slugify } = require("../utils.js");
const {
  appendTaskEvent,
  appendTranscriptEvent,
} = require("./events.js");
const {
  loadManifest,
  taskPaths,
  updateTask,
} = require("./manifest.js");

const DEFAULT_PI_COMMAND = "pi";
const DEFAULT_WORKER_TOOLS = Object.freeze(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const WORKER_ENV_GUARDS = Object.freeze({
  PI_MULTITASK_ROLE: "worker",
});
const DEFAULT_RESPONSE_TIMEOUT_MS = 30_000;
const STARTUP_TIMEOUT_MS = 10_000;
const TERMINAL_TASK_STATUSES = new Set(["cancelled", "merged"]);

function createRpcId(prefix = "rpc") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeTools(tools = DEFAULT_WORKER_TOOLS) {
  if (tools === undefined || tools === null) return undefined;
  if (Array.isArray(tools)) return tools.map((tool) => String(tool).trim()).filter(Boolean).join(",");
  const value = String(tools).trim();
  return value || undefined;
}

function normalizeAppendSystemPrompt(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value.filter((entry) => entry !== undefined && entry !== null).map(String) : [String(value)];
}

function buildPiRpcArgs(options = {}) {
  const args = ["--mode", "rpc"];
  if (options.sessionDir) args.push("--session-dir", options.sessionDir);
  for (const prompt of normalizeAppendSystemPrompt(options.appendSystemPrompt)) {
    args.push("--append-system-prompt", prompt);
  }
  if (options.model) args.push("--model", String(options.model));
  const tools = normalizeTools(options.tools);
  if (tools) args.push("--tools", tools);
  if (Array.isArray(options.extraArgs)) args.push(...options.extraArgs.map(String));
  return args;
}

function workerSessionKey(runId, taskId) {
  return `${slugify(runId, "run")}/${slugify(taskId, "task")}`;
}

function selectTask(manifest, taskId) {
  const normalized = slugify(taskId, "task");
  const task = (manifest.tasks || []).find((candidate) => candidate.id === normalized || candidate.id === taskId);
  if (!task) throw new Error(`No multitask task ${taskId} in run ${manifest.runId}.`);
  return task;
}

function summarizeRpcEvent(event) {
  if (!event || typeof event !== "object") return { type: "unknown" };
  const summary = { type: event.type };
  if (event.command) summary.command = event.command;
  if (event.success !== undefined) summary.success = event.success;
  if (event.error) summary.error = event.error;
  if (event.toolName) summary.toolName = event.toolName;
  if (event.toolCallId) summary.toolCallId = event.toolCallId;
  if (event.message?.role) summary.role = event.message.role;
  if (event.message?.stopReason) summary.stopReason = event.message.stopReason;
  if (event.reason) summary.reason = event.reason;
  return summary;
}

function getLastAssistantMessage(messages) {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return messages[i];
  }
  return undefined;
}

function statusFromAgentEnd(event) {
  const assistant = getLastAssistantMessage(event.messages);
  if (assistant?.stopReason === "error") return "needs_attention";
  return "idle";
}

function statusFromRpcEvent(event) {
  switch (event?.type) {
    case "agent_start":
    case "turn_start":
    case "message_start":
    case "message_update":
    case "tool_execution_start":
    case "tool_execution_update":
    case "compaction_start":
    case "auto_retry_start":
      return "running";
    case "agent_end":
      return statusFromAgentEnd(event);
    case "compaction_end":
    case "auto_retry_end":
      return event.finalError || event.errorMessage ? "needs_attention" : "idle";
    case "extension_error":
      return "needs_attention";
    default:
      return undefined;
  }
}

function activityFromTaskStatus(status) {
  if (status === "running") return "running";
  if (status === "idle") return "idle";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "needs_attention") return "needs_attention";
  return undefined;
}

function inferStateStatus(data) {
  if (!data || typeof data !== "object") return undefined;
  if (data.isStreaming || data.isCompacting || Number(data.pendingMessageCount || 0) > 0) return "running";
  return "idle";
}

function buildDefaultWorkerSystemPrompt({ manifest, task }) {
  return [
    "# Porchestrator Worker",
    "",
    "You are a persistent local Pi worker session managed by Pi multitask mode.",
    "",
    "## Assignment Context",
    `Run: ${manifest.runId}`,
    `Task: ${task.id}${task.title ? ` (${task.title})` : ""}`,
    `Branch: ${task.branch}`,
    `Worktree: ${task.worktree}`,
    "",
    "## Worker Rules",
    "- Work only inside this task worktree unless explicitly instructed otherwise.",
    "- Do not create git commits, branches, or worktrees unless the user explicitly asks.",
    "- Do not spawn multitask worker fleets from this worker session.",
    "- Keep changes scoped to this task and report concise progress/results.",
    "- When idle, stay available for follow-up messages from the main session.",
    "",
  ].join("\n");
}

async function ensureWorkerPromptFile(repoRoot, manifest, task, options = {}) {
  if (options.appendSystemPrompt !== undefined) return options.appendSystemPrompt;
  if (options.appendSystemPromptPath) return options.appendSystemPromptPath;
  const paths = task.paths || taskPaths(repoRoot, manifest.runId, task.id);
  const file = path.join(paths.dir, "worker-prompt.md");
  await ensureDir(paths.dir);
  await fsp.writeFile(file, buildDefaultWorkerSystemPrompt({ manifest, task }), "utf8");
  return file;
}

async function persistTaskWorkerState(repoRoot, runId, taskId, patch = {}, options = {}) {
  const eventType = options.eventType;
  const eventData = options.eventData || {};
  let updatedTask;
  await updateTask(repoRoot, runId, taskId, (task) => {
    const nextWorker = {
      ...(task.worker || {}),
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    task.worker = nextWorker;
    const nextStatus = options.status || activityFromTaskStatus(patch.activityStatus);
    if (nextStatus && !TERMINAL_TASK_STATUSES.has(task.status)) task.status = nextStatus;
    updatedTask = task;
  });
  if (eventType) await appendTaskEvent(repoRoot, runId, updatedTask.id, eventType, eventData);
  return updatedTask;
}

class RpcWorkerSession extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.repoRoot) throw new Error("repoRoot is required for RpcWorkerSession.");
    if (!options.runId) throw new Error("runId is required for RpcWorkerSession.");
    if (!options.taskId) throw new Error("taskId is required for RpcWorkerSession.");
    this.repoRoot = options.repoRoot;
    this.runId = options.runId;
    this.taskId = options.taskId;
    this.task = options.task || {};
    this.cwd = options.cwd || this.task.worktree || options.repoRoot;
    this.paths = options.paths || this.task.paths || taskPaths(this.repoRoot, this.runId, this.taskId);
    this.piCommand = options.piCommand || DEFAULT_PI_COMMAND;
    this.sessionDir = options.sessionDir || this.paths.session;
    this.appendSystemPrompt = options.appendSystemPrompt;
    this.model = options.model || this.task.model;
    this.tools = options.tools === undefined ? DEFAULT_WORKER_TOOLS : options.tools;
    this.extraArgs = options.extraArgs || [];
    this.env = { ...process.env, ...(options.env || {}), ...WORKER_ENV_GUARDS };
    this.spawn = options.spawn || spawn;
    this.responseTimeoutMs = options.responseTimeoutMs || DEFAULT_RESPONSE_TIMEOUT_MS;
    this.proc = undefined;
    this.stdoutLog = undefined;
    this.stderrLog = undefined;
    this.stdoutBuffer = "";
    this.pending = new Map();
    this.persistence = Promise.resolve();
    this.startedAt = undefined;
    this.exitedAt = undefined;
    this.processStatus = "new";
    this.activityStatus = "idle";
    this.lastEventType = undefined;
    this.lastEventAt = undefined;
    this.lastResponseAt = undefined;
    this.lastError = undefined;
    this.rpcState = undefined;
    this.exitCode = undefined;
    this.signal = undefined;
    this.stopping = false;
  }

  get pid() {
    return this.proc?.pid;
  }

  get isAlive() {
    return !!this.proc && !["exited", "failed"].includes(this.processStatus);
  }

  get isIdle() {
    return this.isAlive && this.activityStatus === "idle";
  }

  get isRunning() {
    return this.isAlive && this.activityStatus === "running";
  }

  getStatus() {
    return {
      runId: this.runId,
      taskId: this.taskId,
      pid: this.pid,
      processStatus: this.processStatus,
      activityStatus: this.activityStatus,
      isAlive: this.isAlive,
      isIdle: this.isIdle,
      isRunning: this.isRunning,
      startedAt: this.startedAt,
      exitedAt: this.exitedAt,
      exitCode: this.exitCode,
      signal: this.signal,
      lastEventType: this.lastEventType,
      lastEventAt: this.lastEventAt,
      lastResponseAt: this.lastResponseAt,
      lastError: this.lastError,
      pendingResponses: this.pending.size,
      sessionDir: this.sessionDir,
      cwd: this.cwd,
      rpcState: this.rpcState,
    };
  }

  buildArgs() {
    return buildPiRpcArgs({
      sessionDir: this.sessionDir,
      appendSystemPrompt: this.appendSystemPrompt,
      model: this.model,
      tools: this.tools,
      extraArgs: this.extraArgs,
    });
  }

  async start() {
    if (this.proc) return this;
    await ensureDir(this.paths.dir);
    await ensureDir(this.sessionDir);
    this.stdoutLog = fs.createWriteStream(this.paths.stdout, { flags: "a" });
    this.stderrLog = fs.createWriteStream(this.paths.stderr, { flags: "a" });
    const args = this.buildArgs();
    this.processStatus = "starting";
    this.activityStatus = "idle";
    this.startedAt = new Date().toISOString();
    this.enqueuePersistence(async () => {
      await persistTaskWorkerState(this.repoRoot, this.runId, this.taskId, {
        pid: undefined,
        processStatus: "starting",
        activityStatus: "idle",
        command: this.piCommand,
        args,
        cwd: this.cwd,
        sessionDir: this.sessionDir,
        startedAt: this.startedAt,
        envGuards: WORKER_ENV_GUARDS,
      }, {
        eventType: "worker_process_starting",
        eventData: { command: this.piCommand, args, cwd: this.cwd, sessionDir: this.sessionDir },
        status: "running",
      });
    });

    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve();
      }, STARTUP_TIMEOUT_MS);
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };

      try {
        this.proc = this.spawn(this.piCommand, args, {
          cwd: this.cwd,
          env: this.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        this.markStartFailure(error);
        finish(reject, error);
        return;
      }

      this.proc.once("spawn", () => {
        this.processStatus = "running";
        this.emit("process", this.getStatus());
        this.enqueuePersistence(async () => {
          await persistTaskWorkerState(this.repoRoot, this.runId, this.taskId, {
            pid: this.pid,
            processStatus: "running",
            activityStatus: this.activityStatus,
          }, {
            eventType: "worker_process_started",
            eventData: { pid: this.pid },
            status: "running",
          });
        });
        finish(resolve);
      });
      this.proc.once("error", (error) => {
        this.markStartFailure(error);
        finish(reject, error);
      });
      this.proc.stdout?.on("data", (chunk) => this.handleStdoutChunk(chunk));
      this.proc.stderr?.on("data", (chunk) => this.handleStderrChunk(chunk));
      this.proc.once("close", (code, signalName) => this.handleProcessClose(code, signalName));
    });
    return this;
  }

  markStartFailure(error) {
    this.processStatus = "failed";
    this.activityStatus = "failed";
    this.lastError = error.message;
    this.enqueuePersistence(async () => {
      await persistTaskWorkerState(this.repoRoot, this.runId, this.taskId, {
        processStatus: "failed",
        activityStatus: "failed",
        error: error.message,
      }, {
        eventType: "worker_process_failed",
        eventData: { error: error.message },
        status: "failed",
      });
    });
  }

  sendCommand(type, payload = {}, options = {}) {
    if (!type || typeof type !== "string") throw new Error("RPC command type is required.");
    if (!this.proc || !this.proc.stdin || this.processStatus === "exited" || this.processStatus === "failed") {
      throw new Error(`Worker session ${this.runId}/${this.taskId} is not running.`);
    }
    const id = options.id || createRpcId(type);
    const command = { id, type, ...payload };
    const timeoutMs = options.timeoutMs ?? this.responseTimeoutMs;

    const promise = new Promise((resolve, reject) => {
      let timer;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Timed out waiting for worker RPC response to ${type}.`));
        }, timeoutMs);
      }
      this.pending.set(id, { type, resolve, reject, timer });
      try {
        this.proc.stdin.write(JSON.stringify(command) + "\n", "utf8", (error) => {
          if (error) {
            if (timer) clearTimeout(timer);
            this.pending.delete(id);
            reject(error);
          }
        });
      } catch (error) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });

    this.enqueuePersistence(async () => {
      await appendTranscriptEvent(this.repoRoot, this.runId, this.taskId, {
        direction: "stdin",
        kind: "command",
        command,
      });
      await appendTaskEvent(this.repoRoot, this.runId, this.taskId, "worker_rpc_command_sent", {
        command: type,
        id,
      });
    });
    return promise;
  }

  prompt(message, options = {}) {
    this.activityStatus = "running";
    this.updateStatusFromLocalChange("running", { lastCommand: "prompt" });
    return this.sendCommand("prompt", {
      message,
      images: options.images,
      streamingBehavior: options.streamingBehavior,
    }, options);
  }

  steer(message, options = {}) {
    return this.sendCommand("steer", { message, images: options.images }, options);
  }

  followUp(message, options = {}) {
    return this.sendCommand("follow_up", { message, images: options.images }, options);
  }

  follow_up(message, options = {}) {
    return this.followUp(message, options);
  }

  abort(options = {}) {
    return this.sendCommand("abort", {}, options);
  }

  getState(options = {}) {
    return this.sendCommand("get_state", {}, options).then((response) => response.data);
  }

  getMessages(options = {}) {
    return this.sendCommand("get_messages", {}, options).then((response) => response.data);
  }

  handleStdoutChunk(chunk) {
    const text = chunk.toString("utf8");
    this.stdoutLog?.write(text);
    this.stdoutBuffer += text;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || "";
    for (const line of lines) this.handleStdoutLine(line);
  }

  handleStdoutLine(line) {
    if (!line.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      const entry = { raw: line, error: error.message };
      this.enqueuePersistence(async () => {
        await appendTranscriptEvent(this.repoRoot, this.runId, this.taskId, {
          direction: "stdout",
          kind: "malformed_jsonl",
          ...entry,
        });
        await appendTaskEvent(this.repoRoot, this.runId, this.taskId, "worker_rpc_malformed_stdout", entry);
      });
      return;
    }
    this.handleRpcMessage(parsed);
  }

  handleStderrChunk(chunk) {
    const text = chunk.toString("utf8");
    this.stderrLog?.write(text);
  }

  handleRpcMessage(message) {
    const receivedAt = new Date().toISOString();
    if (message?.type === "response") this.handleRpcResponse(message, receivedAt);
    else this.handleRpcEvent(message, receivedAt);
  }

  handleRpcResponse(response, receivedAt) {
    this.lastResponseAt = receivedAt;
    const pending = response.id ? this.pending.get(response.id) : undefined;
    if (pending) {
      this.pending.delete(response.id);
      if (pending.timer) clearTimeout(pending.timer);
    }
    if (response.command === "get_state" && response.success) {
      this.rpcState = response.data;
      const inferred = inferStateStatus(response.data);
      if (inferred) this.activityStatus = inferred;
    }
    if (response.command === "abort" && response.success) this.activityStatus = "idle";
    if (response.command === "prompt" && response.success) this.activityStatus = "running";
    this.enqueuePersistence(async () => {
      await appendTranscriptEvent(this.repoRoot, this.runId, this.taskId, {
        direction: "stdout",
        kind: "response",
        response,
      });
      await appendTaskEvent(this.repoRoot, this.runId, this.taskId, "worker_rpc_response", {
        id: response.id,
        command: response.command,
        success: response.success,
        error: response.error,
      });
      const inferred = response.command === "get_state" && response.success ? inferStateStatus(response.data) : undefined;
      if (inferred || response.command === "prompt" || response.command === "abort") {
        await persistTaskWorkerState(this.repoRoot, this.runId, this.taskId, {
          pid: this.pid,
          processStatus: this.processStatus,
          activityStatus: inferred || this.activityStatus,
          rpcState: this.rpcState,
          lastResponseAt: receivedAt,
          lastCommand: response.command,
        }, { status: inferred || this.activityStatus });
      }
    });
    this.emit("response", response);
    if (pending) {
      if (response.success) pending.resolve(response);
      else pending.reject(new Error(response.error || `Worker RPC command ${response.command || pending.type} failed.`));
    }
  }

  handleRpcEvent(event, receivedAt) {
    this.lastEventType = event?.type;
    this.lastEventAt = receivedAt;
    const nextStatus = statusFromRpcEvent(event);
    if (nextStatus) this.activityStatus = nextStatus;
    const summary = summarizeRpcEvent(event);
    this.enqueuePersistence(async () => {
      await appendTranscriptEvent(this.repoRoot, this.runId, this.taskId, {
        direction: "stdout",
        kind: "event",
        event,
      });
      if ([
        "agent_start",
        "agent_end",
        "tool_execution_start",
        "tool_execution_end",
        "compaction_start",
        "compaction_end",
        "auto_retry_start",
        "auto_retry_end",
        "extension_error",
      ].includes(event?.type)) {
        await appendTaskEvent(this.repoRoot, this.runId, this.taskId, "worker_rpc_event", summary);
      }
      if (nextStatus) {
        await persistTaskWorkerState(this.repoRoot, this.runId, this.taskId, {
          pid: this.pid,
          processStatus: this.processStatus,
          activityStatus: nextStatus,
          lastEventType: event?.type,
          lastEventAt: receivedAt,
          lastEvent: summary,
        }, { status: nextStatus });
      }
    });
    this.emit("event", event);
  }

  updateStatusFromLocalChange(status, patch = {}) {
    this.enqueuePersistence(async () => {
      await persistTaskWorkerState(this.repoRoot, this.runId, this.taskId, {
        pid: this.pid,
        processStatus: this.processStatus,
        activityStatus: status,
        ...patch,
      }, { status });
    });
  }

  handleProcessClose(code, signalName) {
    this.exitCode = code;
    this.signal = signalName;
    this.exitedAt = new Date().toISOString();
    this.processStatus = "exited";
    if (!this.stopping && code !== 0) {
      this.activityStatus = "failed";
      this.lastError = `Worker process exited with code ${code}${signalName ? ` (${signalName})` : ""}.`;
    } else if (this.activityStatus !== "cancelled") {
      this.activityStatus = "idle";
    }
    if (this.stdoutBuffer.trim()) {
      const buffered = this.stdoutBuffer;
      this.stdoutBuffer = "";
      this.handleStdoutLine(buffered);
    }
    this.stdoutLog?.end();
    this.stderrLog?.end();
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error(`Worker process exited before responding to ${pending.type}.`));
      this.pending.delete(id);
    }
    const status = this.activityStatus === "failed" ? "failed" : undefined;
    this.enqueuePersistence(async () => {
      await persistTaskWorkerState(this.repoRoot, this.runId, this.taskId, {
        pid: this.pid,
        processStatus: "exited",
        activityStatus: this.activityStatus,
        exitedAt: this.exitedAt,
        exitCode: code,
        signal: signalName,
        error: this.lastError,
      }, {
        eventType: "worker_process_exited",
        eventData: { exitCode: code, signal: signalName, error: this.lastError },
        status,
      });
    });
    this.emit("exit", { code, signal: signalName, status: this.getStatus() });
  }

  enqueuePersistence(fn) {
    this.persistence = this.persistence.then(fn, fn).catch((error) => {
      this.lastError = error.message;
      this.emit("persistence_error", error);
    });
    return this.persistence;
  }

  async waitForPersistence() {
    await this.persistence;
  }

  async stop(options = {}) {
    this.stopping = true;
    if (!this.proc || this.processStatus === "exited" || this.processStatus === "failed") return;
    const timeoutMs = options.timeoutMs ?? 5_000;
    if (options.abort !== false) {
      await this.abort({ timeoutMs: Math.min(timeoutMs, this.responseTimeoutMs) }).catch(() => {});
    }
    this.proc.stdin?.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.proc && !this.proc.killed) this.proc.kill("SIGTERM");
        resolve();
      }, timeoutMs);
      this.proc.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

async function createWorkerSessionForTask(input, options = {}) {
  const manifest = input.manifest || await loadManifest(input.repoRoot, input.runId);
  const repoRoot = input.repoRoot || manifest.repoRoot;
  const task = input.task || selectTask(manifest, input.taskId);
  const appendSystemPrompt = await ensureWorkerPromptFile(repoRoot, manifest, task, options);
  return new RpcWorkerSession({
    repoRoot,
    runId: manifest.runId,
    taskId: task.id,
    task,
    cwd: task.worktree,
    paths: task.paths || taskPaths(repoRoot, manifest.runId, task.id),
    sessionDir: options.sessionDir || task.paths?.session,
    appendSystemPrompt,
    model: options.model || task.model,
    tools: options.tools,
    piCommand: options.piCommand,
    extraArgs: options.extraArgs,
    env: options.env,
    spawn: options.spawn,
    responseTimeoutMs: options.responseTimeoutMs,
  });
}

async function startTaskWorkerSession(input, options = {}) {
  const session = await createWorkerSessionForTask(input, options);
  await session.start();
  if (options.sendInitialPrompt !== false) {
    await session.prompt(input.task?.prompt || session.task.prompt, { timeoutMs: options.initialPromptTimeoutMs || session.responseTimeoutMs });
  }
  return session;
}

function chooseMessageCommand(session, mode) {
  if (session?.isIdle) return "prompt";
  if (mode === "steer") return "steer";
  return "follow_up";
}

async function sendWorkerMessage(session, message, options = {}) {
  const command = chooseMessageCommand(session, options.mode);
  if (command === "prompt") return { command, response: await session.prompt(message, options) };
  if (command === "steer") return { command, response: await session.steer(message, options) };
  return { command, response: await session.followUp(message, options) };
}

module.exports = {
  DEFAULT_PI_COMMAND,
  DEFAULT_RESPONSE_TIMEOUT_MS,
  DEFAULT_WORKER_TOOLS,
  RpcWorkerSession,
  WORKER_ENV_GUARDS,
  buildDefaultWorkerSystemPrompt,
  buildPiRpcArgs,
  chooseMessageCommand,
  createRpcId,
  createWorkerSessionForTask,
  ensureWorkerPromptFile,
  persistTaskWorkerState,
  sendWorkerMessage,
  startTaskWorkerSession,
  statusFromRpcEvent,
  workerSessionKey,
};
