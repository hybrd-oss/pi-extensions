const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const http = require("node:http");
const { Writable } = require("node:stream");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const multitask = require("../src/multitask/index.js");
const { git: testGit } = require("../src/git.js");

function fixtureManifest(repoRoot, overrides = {}) {
  const runId = overrides.runId || "phase-6";
  const stateDir = multitask.manifest.runDir(repoRoot, runId);
  const worktreeRoot = path.join(repoRoot, "../worktrees");
  const task = {
    id: "api",
    prompt: "Mock task",
    status: "planned",
    branch: "mt/phase-6/api",
    worktree: path.join(worktreeRoot, runId, "api"),
    paths: multitask.manifest.taskPaths(repoRoot, runId, "api"),
    startupScripts: [],
    validationScripts: [],
  };
  return {
    schemaVersion: multitask.manifest.MULTITASK_SCHEMA_VERSION,
    kind: "pi-multitask-run",
    runId,
    runName: "Phase 6",
    status: "planned",
    createdAt: "2026-05-24T00:00:00.000Z",
    updatedAt: "2026-05-24T00:00:00.000Z",
    baseRef: "HEAD",
    baseCommit: "abc123",
    baseBranch: "main",
    repoRoot,
    stateDir,
    worktreeRoot,
    tasks: [task],
    integration: {
      id: "integration",
      status: "planned",
      branch: "mt/phase-6/integration",
      worktree: path.join(worktreeRoot, runId, "integration"),
      startupScripts: [],
      validationScripts: [],
    },
    ...overrides,
  };
}

async function withTempRepo(fn) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mt-no-credit-"));
  const repoRoot = path.join(tempRoot, "repo");
  await fs.mkdir(repoRoot, { recursive: true });
  try {
    return await fn(repoRoot, tempRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function execGit(cwd, args, options = {}) {
  const result = await testGit(cwd, args, { allowFailure: true, timeoutSeconds: options.timeoutSeconds || 120 });
  if (options.allowFailure === true) return result;
  assert.equal(result.exitCode, 0, `git ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

async function writeFileEnsured(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}

function httpRequestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: options.method || "GET",
      headers: options.headers || {},
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        let json;
        try { json = body ? JSON.parse(body) : undefined; } catch { json = undefined; }
        resolve({ statusCode: response.statusCode, headers: response.headers, body, json });
      });
    });
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

async function initGitFixture(repoRoot) {
  await execGit(repoRoot, ["init"]);
  await execGit(repoRoot, ["config", "user.email", "multitask@example.test"]);
  await execGit(repoRoot, ["config", "user.name", "Multitask Test"]);
  await writeFileEnsured(path.join(repoRoot, "README.md"), "# fixture\n");
  await execGit(repoRoot, ["add", "."]);
  await execGit(repoRoot, ["commit", "-m", "initial"]);
  return (await execGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
}

function createFakePiProcess() {
  const proc = new EventEmitter();
  proc.pid = 424242;
  proc.killed = false;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => {
    proc.killed = true;
    process.nextTick(() => proc.emit("close", 0, null));
    return true;
  };
  proc.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const command = JSON.parse(chunk.toString("utf8"));
      process.nextTick(() => {
        proc.stdout.emit("data", JSON.stringify({
          type: "response",
          id: command.id,
          command: command.type,
          success: true,
          data: command.type === "get_state" ? { isStreaming: false, pendingMessageCount: 0 } : { ok: true },
        }) + "\n");
      });
      callback();
    },
  });
  const originalEnd = proc.stdin.end.bind(proc.stdin);
  proc.stdin.end = (...args) => {
    originalEnd(...args);
    process.nextTick(() => proc.emit("close", 0, null));
  };
  process.nextTick(() => proc.emit("spawn"));
  return proc;
}

test("protocol validates, decodes, and reports malformed lines", () => {
  const request = multitask.protocol.createRequest(multitask.protocol.METHODS.STATUS, { runId: "r" }, { id: "req-1" });
  assert.equal(request.protocol, "pi-multitask");
  assert.equal(request.id, "req-1");
  assert.deepEqual(multitask.protocol.decodeLine(multitask.protocol.encodeMessage(request)), request);

  const seen = [];
  const errors = [];
  const decode = multitask.protocol.createLineDecoder((message) => seen.push(message), (error, line) => errors.push({ error, line }));
  decode(Buffer.from(multitask.protocol.encodeMessage(request).slice(0, 10)));
  decode(Buffer.from(multitask.protocol.encodeMessage(request).slice(10) + "not-json\n"));
  assert.equal(seen.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error.message, /Unexpected token|not valid JSON/);
});

test("dashboard auth generates local bearer/cookie tokens without loose comparison", () => {
  const auth = multitask.dashboardAuth.createDashboardAuth({ token: "secret-token" });
  assert.equal(auth.validate("secret-token"), true);
  assert.equal(auth.validate("secret-token-2"), false);
  assert.equal(auth.validate(""), false);
  assert.match(multitask.dashboardAuth.generateDashboardToken(), /^[A-Za-z0-9_-]{32,}$/);
  assert.equal(multitask.dashboardAuth.redactToken("abcdefghijklmnopqrstuvwxyz").includes("ghijklmnop"), false);
  assert.deepEqual(multitask.dashboardAuth.parseCookieHeader("a=1; pi_mt_dashboard_token=abc%201"), { a: "1", pi_mt_dashboard_token: "abc 1" });
});

test("dashboard API bounds transcript and diff payloads", async () => withTempRepo(async (repoRoot) => {
  await multitask.manifest.initializeRunState(repoRoot, fixtureManifest(repoRoot));
  for (let index = 0; index < multitask.dashboardApi.MAX_LIMIT + 25; index += 1) {
    await multitask.events.appendTranscriptEvent(repoRoot, "phase-6", "api", { type: "worker_output", text: `entry ${index}` });
  }
  await multitask.events.appendTranscriptEvent(repoRoot, "phase-6", "api", { type: "worker_output", text: "x".repeat(80_000) });

  const client = {
    async diff() {
      return {
        runId: "phase-6",
        targetId: "api",
        targetType: "task",
        changedFiles: Array.from({ length: 260 }, (_, index) => ({ path: `file-${index}.js`, status: "M" })),
        committed: { shortstat: "260 files changed", stat: "x".repeat(80_000) },
        workingTree: { shortstat: "", stat: "", status: [] },
        summary: "summary",
      };
    },
  };
  const api = multitask.dashboardApi.createDashboardApi({ repoRoot, client });
  const transcript = await api.transcript("phase-6", "api", { limit: 10_000 });
  assert.equal(transcript.limit, multitask.dashboardApi.MAX_LIMIT);
  assert.equal(transcript.entries.length, multitask.dashboardApi.MAX_LIMIT);
  assert.equal(transcript.entries.at(-1).truncated, true);

  const diff = await api.diff("phase-6", "api", { maxFiles: 10_000 });
  assert.equal(diff.changedFiles.length, multitask.dashboardApi.MAX_DIFF_FILE_LIMIT);
  assert.equal(diff.changedFileCount, 260);
  assert.equal(diff.changedFilesTruncated, true);
  assert.equal(diff.committed.stat.truncated, true);
}));

test("dashboard message API sends safe worker and run messages through daemon client", async () => withTempRepo(async (repoRoot) => {
  await multitask.manifest.initializeRunState(repoRoot, fixtureManifest(repoRoot, {
    status: "running",
    tasks: [
      { ...fixtureManifest(repoRoot).tasks[0], status: "running" },
      {
        id: "docs",
        prompt: "Docs task",
        status: "queued",
        branch: "mt/phase-6/docs",
        worktree: path.join(repoRoot, "../worktrees", "phase-6", "docs"),
        paths: multitask.manifest.taskPaths(repoRoot, "phase-6", "docs"),
        startupScripts: [],
        validationScripts: [],
      },
      {
        id: "done",
        prompt: "Done task",
        status: "merged",
        branch: "mt/phase-6/done",
        worktree: path.join(repoRoot, "../worktrees", "phase-6", "done"),
        worker: { attachmentState: "completed" },
        paths: multitask.manifest.taskPaths(repoRoot, "phase-6", "done"),
        startupScripts: [],
        validationScripts: [],
      },
    ],
  }));
  const calls = [];
  const client = {
    async message(params) {
      calls.push(params);
      return { runId: params.runId, taskId: params.taskId, command: "prompt", mode: params.mode, type: params.type, restarted: params.restartIfNeeded === true };
    },
  };
  const api = multitask.dashboardApi.createDashboardApi({ repoRoot, client });
  const sent = await api.messageTask("phase-6", "api", { message: "Please pause.", mode: "steer", type: "inform", restartIfNeeded: true });
  assert.equal(sent.ok, true);
  assert.equal(calls[0].taskId, "api");
  assert.equal(calls[0].mode, "steer");
  assert.equal(calls[0].restartIfNeeded, true);
  assert.equal(calls[0].message, "Please pause.");

  const typed = await api.messageTask("phase-6", "api", { message: "Use option A.", mode: "followUp", type: "decision" });
  assert.equal(typed.ok, true);
  assert.equal(calls[1].message.type, "decision");
  assert.equal(calls[1].message.message, "Use option A.");

  const broadcast = await api.messageRun("phase-6", { message: "Status?", scope: "all", mode: "followUp", type: "question" });
  assert.equal(broadcast.sentCount, 2);
  assert.deepEqual(broadcast.requestedTaskIds, ["api", "docs"]);
  assert.equal(calls[2].taskId, "api");
  assert.equal(calls[3].taskId, "docs");

  await assert.rejects(() => api.messageTask("phase-6", "done", { message: "Restart?", restartIfNeeded: true }), /not allowed for terminal/);
  assert.throws(() => multitask.dashboardApi.normalizeDashboardMessageInput({ message: " ", mode: "steer" }), /Message text is required/);
  assert.throws(() => multitask.dashboardApi.normalizeDashboardMessageInput({ message: {}, mode: "steer" }), /Message text is required/);
  assert.throws(() => multitask.dashboardApi.normalizeDashboardMessageInput({ message: "x", mode: "prompt" }), /Unsupported message mode/);
}));

test("dashboard status DTO is compact and omits full prompts", () => {
  const envelope = multitask.dashboardApi.createStatusEnvelope({
    runs: [{
      runId: "compact-run",
      status: "running",
      tasks: [{ id: "api", status: "running", prompt: "do a lot".repeat(10_000), paths: { secret: "/tmp/session" } }],
    }],
  });
  assert.equal(envelope.runs.length, 1);
  assert.equal(envelope.runs[0].tasks.length, 1);
  assert.equal(Object.hasOwn(envelope.runs[0].tasks[0], "prompt"), false);
  assert.equal(Object.hasOwn(envelope.runs[0].tasks[0], "paths"), false);
});

test("dashboard server binds localhost, requires auth for API, serves health, messages, and stops", async () => {
  const messages = [];
  const server = new multitask.dashboardServer.DashboardServer({
    repoRoot: "/tmp/repo",
    portRange: [0],
    api: {
      async status() { return { kind: "fake-status", runs: [], totals: { runs: 0 } }; },
      async messageTask(runId, taskId, body) { messages.push({ runId, taskId, body }); return { ok: true, runId, taskId, summary: "sent" }; },
      async messageRun(runId, body) { messages.push({ runId, body }); return { ok: true, runId, sentCount: 1, results: [{ ok: true, taskId: "api" }] }; },
    },
  });
  await server.start();
  try {
    assert.equal(server.host, "127.0.0.1");
    assert.equal(server.isRunning(), true);
    const base = `http://127.0.0.1:${server.port}`;
    const health = await httpRequestJson(`${base}/health`);
    assert.equal(health.statusCode, 200);
    assert.equal(health.json.localOnly, true);

    const denied = await httpRequestJson(`${base}/api/status`);
    assert.equal(denied.statusCode, 401);

    const allowed = await httpRequestJson(`${base}/api/status`, { headers: { authorization: `Bearer ${server.auth.token}` } });
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.json.kind, "fake-status");

    const queryAllowed = await httpRequestJson(`${base}/api/status?token=${encodeURIComponent(server.auth.token)}`);
    assert.equal(queryAllowed.statusCode, 200);

    const page = await httpRequestJson(`${base}/?token=${encodeURIComponent(server.auth.token)}&runId=phase-6`);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Porchestrator Dashboard/);

    const deniedPost = await httpRequestJson(`${base}/api/runs/phase-6/tasks/api/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    assert.equal(deniedPost.statusCode, 401);

    const messagePost = await httpRequestJson(`${base}/api/runs/phase-6/tasks/api/message`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.auth.token}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "hello", mode: "steer" }),
    });
    assert.equal(messagePost.statusCode, 200);
    assert.deepEqual(messages[0], { runId: "phase-6", taskId: "api", body: { message: "hello", mode: "steer" } });

    const runPost = await httpRequestJson(`${base}/api/runs/phase-6/message`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.auth.token}`, "content-type": "text/plain" },
      body: "hello run",
    });
    assert.equal(runPost.statusCode, 200);
    assert.deepEqual(messages[1], { runId: "phase-6", body: "hello run" });
  } finally {
    await server.stop();
  }
  assert.equal(server.isRunning(), false);
});

test("manifest writes are atomic under concurrent saves", async () => withTempRepo(async (repoRoot) => {
  const manifest = fixtureManifest(repoRoot, {
    runId: "atomic-run",
    tasks: Array.from({ length: 8 }, (_, index) => ({
      id: `task-${index}`,
      prompt: "x".repeat(10_000),
      status: index % 2 ? "queued" : "running",
      branch: `mt/atomic-run/task-${index}`,
      worktree: path.join(repoRoot, "../worktrees", "atomic-run", `task-${index}`),
      paths: multitask.manifest.taskPaths(repoRoot, "atomic-run", `task-${index}`),
      startupScripts: [],
      validationScripts: [],
    })),
  });
  await Promise.all(Array.from({ length: 25 }, async (_, index) => {
    await multitask.manifest.saveManifest(repoRoot, { ...manifest, marker: index });
  }));
  const loaded = await multitask.manifest.loadManifest(repoRoot, "atomic-run");
  assert.equal(loaded.runId, "atomic-run");
  assert.equal(loaded.tasks.length, 8);
  assert.equal(typeof loaded.marker, "number");
}));

test("run references resolve display names and prefixes to canonical run ids", async () => withTempRepo(async (repoRoot) => {
  const runId = "20260528-190421-taskatlas-real-manual-3cf33d";
  await multitask.manifest.initializeRunState(repoRoot, fixtureManifest(repoRoot, {
    runId,
    runName: "taskatlas-real-manual",
  }));

  assert.equal(await multitask.manifest.resolveRunId(repoRoot, runId), runId);
  assert.equal(await multitask.manifest.resolveRunId(repoRoot, "20260528-190421"), runId);
  assert.equal(await multitask.manifest.resolveRunId(repoRoot, "taskatlas-real-manual"), runId);
  assert.equal((await multitask.manifest.loadManifestByRef(repoRoot, "taskatlas-real-manual")).runId, runId);

  await multitask.manifest.initializeRunState(repoRoot, fixtureManifest(repoRoot, {
    runId: "20260528-200000-taskatlas-real-manual-abcd12",
    runName: "taskatlas-real-manual",
  }));
  await assert.rejects(() => multitask.manifest.resolveRunId(repoRoot, "taskatlas-real-manual"), /ambiguous/i);
}));

test("multitask contracts expose canonical status, attachment, and message names", () => {
  const contracts = multitask.contracts;
  assert.deepEqual(contracts.TASK_STATUSES, [
    "planned",
    "creating_worktree",
    "setup",
    "queued",
    "blocked",
    "running",
    "idle",
    "needs_attention",
    "ready_for_review",
    "needs_changes",
    "ready_to_merge",
    "merged",
    "failed",
    "aborted",
  ]);
  assert.deepEqual(contracts.WORKER_ATTACHMENT_STATES, ["attached", "detached_idle", "lost_running", "completed"]);
  assert.deepEqual(contracts.MESSAGE_TYPES, ["assignment", "question", "inform", "review_feedback", "decision", "report_done", "report_blocked"]);
  assert.equal(contracts.taskStatusCategory("needs_changes"), "attention");
  assert.equal(contracts.isReadyTaskStatus("ready_to_merge"), true);
  assert.throws(() => contracts.assertTaskStatus("cancelled"), /task status must be one of/);
});

test("scheduler enforces maxConcurrency for queued tasks", () => {
  const { TASK_STATUS } = multitask.contracts;
  const manifest = {
    runId: "scheduler-capacity",
    maxConcurrency: 2,
    tasks: ["one", "two", "three", "four", "five"].map((id) => ({ id, status: TASK_STATUS.QUEUED })),
  };

  const plan = multitask.scheduler.planSchedule(manifest, { now: "2026-05-28T12:00:00.000Z" });
  assert.equal(plan.maxConcurrency, 2);
  assert.equal(plan.capacity, 2);
  assert.deepEqual(plan.selectedTaskIds, ["one", "two"]);
  assert.deepEqual(plan.startTaskIds, ["one", "two"]);
  assert.equal(plan.updates.filter((update) => update.toStatus === TASK_STATUS.RUNNING).length, 2);

  const applied = multitask.scheduler.applySchedulingPlan(manifest, plan);
  assert.deepEqual(applied.tasks.map((task) => `${task.id}:${task.status}`), [
    "one:running",
    "two:running",
    "three:queued",
    "four:queued",
    "five:queued",
  ]);
  assert.deepEqual(manifest.tasks.map((task) => task.status), Array(5).fill(TASK_STATUS.QUEUED));
});

test("scheduler starts the next queued task when a running task completes or idles", () => {
  const { TASK_STATUS } = multitask.contracts;
  const base = {
    runId: "scheduler-completion",
    maxConcurrency: 2,
    tasks: [
      { id: "one", status: TASK_STATUS.RUNNING },
      { id: "two", status: TASK_STATUS.RUNNING },
      { id: "three", status: TASK_STATUS.QUEUED },
      { id: "four", status: TASK_STATUS.QUEUED },
    ],
  };

  const noCapacity = multitask.scheduler.planSchedule(base, { now: "2026-05-28T12:00:00.000Z" });
  assert.deepEqual(noCapacity.selectedTaskIds, []);

  const completed = multitask.scheduler.completeTaskAndPlan(base, "one", {
    now: "2026-05-28T12:01:00.000Z",
    status: TASK_STATUS.READY_FOR_REVIEW,
  });
  assert.deepEqual(completed.schedule.selectedTaskIds, ["three"]);
  assert.equal(completed.result.tasks.find((task) => task.id === "one").status, TASK_STATUS.READY_FOR_REVIEW);
  assert.equal(completed.result.tasks.find((task) => task.id === "three").status, TASK_STATUS.RUNNING);

  const idled = multitask.scheduler.idleTaskAndPlan(base, "one", { now: "2026-05-28T12:02:00.000Z" });
  assert.deepEqual(idled.schedule.selectedTaskIds, ["three"]);
  assert.equal(idled.result.tasks.find((task) => task.id === "one").status, TASK_STATUS.IDLE);
  assert.equal(idled.result.tasks.find((task) => task.id === "three").status, TASK_STATUS.RUNNING);
});

test("scheduler blocks dependent tasks until prerequisites are ready", () => {
  const { TASK_STATUS } = multitask.contracts;
  const manifest = {
    runId: "scheduler-dependencies",
    maxConcurrency: 2,
    tasks: [
      { id: "api", status: TASK_STATUS.RUNNING },
      { id: "ui", status: TASK_STATUS.QUEUED, dependencies: ["api"] },
      { id: "docs", status: TASK_STATUS.QUEUED },
    ],
  };

  const blocked = multitask.scheduler.planSchedule(manifest, { now: "2026-05-28T12:00:00.000Z" });
  assert.deepEqual(blocked.selectedTaskIds, ["docs"]);
  assert.equal(blocked.updates.find((update) => update.taskId === "ui").toStatus, TASK_STATUS.BLOCKED);
  assert.deepEqual(blocked.updates.find((update) => update.taskId === "ui").patch.blockedBy, ["api"]);
  const blockedApplied = multitask.scheduler.applySchedulingPlan(manifest, blocked);
  assert.equal(blockedApplied.tasks.find((task) => task.id === "ui").status, TASK_STATUS.BLOCKED);
  assert.equal(blockedApplied.tasks.find((task) => task.id === "docs").status, TASK_STATUS.RUNNING);

  const ready = {
    ...blockedApplied,
    tasks: blockedApplied.tasks.map((task) => task.id === "api" ? { ...task, status: TASK_STATUS.READY_FOR_REVIEW } : task),
  };
  const unblocked = multitask.scheduler.planSchedule(ready, { now: "2026-05-28T12:03:00.000Z" });
  assert.deepEqual(unblocked.selectedTaskIds, ["ui"]);
  assert.deepEqual(unblocked.updates.map((update) => `${update.taskId}:${update.fromStatus}->${update.toStatus}`), [
    "ui:blocked->queued",
    "ui:queued->running",
  ]);
});

test("workflow validates explicit dependencies and reports unknown tasks and cycles", () => {
  const plan = multitask.workflow.compileWorkflow({
    tasks: [{ id: "api" }, { id: "ui" }, { id: "tests" }],
    dependencies: [
      { before: "api", after: "tests" },
      { before: "ui", after: "tests" },
    ],
  });

  assert.deepEqual(plan.dependencies.map((edge) => `${edge.before}->${edge.after}`), ["api->tests", "ui->tests"]);
  assert.deepEqual(plan.waves, [["api", "ui"], ["tests"]]);
  assert.equal(plan.taskWaves.tests, 1);
  assert.match(plan.mermaid, /flowchart TD/);
  assert.match(plan.mermaid, /api --> tests/);

  assert.throws(
    () => multitask.workflow.compileWorkflow({
      tasks: [{ id: "api" }],
      dependencies: [{ before: "api", after: "missing" }],
    }),
    /unknown task id\(s\): missing\. Known tasks: api/,
  );

  assert.throws(
    () => multitask.workflow.compileWorkflow({
      tasks: [{ id: "api" }, { id: "ui" }],
      dependencies: [{ before: "api", after: "ui" }, { before: "ui", after: "api" }],
    }),
    /cycle detected \(api -> ui -> api\)/,
  );
});

test("workflow parses sequence, parallel, join, and finite loop nodes", () => {
  const plan = multitask.workflow.compileWorkflow({
    tasks: [{ id: "api" }, { id: "ui" }, { id: "tests" }, { id: "docs" }],
    workflow: {
      kind: "sequence",
      steps: [
        { kind: "parallel", tasks: ["api", "ui"] },
        { kind: "join", after: ["api", "ui"], before: "tests" },
        { kind: "loop", maxIterations: 2, steps: [{ kind: "spawn", task: "docs" }] },
      ],
    },
  });

  assert.equal(plan.tree.kind, "sequence");
  assert.equal(plan.tree.children[2].kind, "loop");
  assert.equal(plan.tree.children[2].mode, "finite_body_only");
  assert.deepEqual(plan.dependencies.map((edge) => `${edge.before}->${edge.after}`), [
    "api->tests",
    "ui->tests",
    "tests->docs",
  ]);
  assert.deepEqual(plan.waves, [["api", "ui"], ["tests"], ["docs"]]);
});

test("scheduler uses run-level workflow dependencies for wave scheduling and readiness policy", () => {
  const { TASK_STATUS } = multitask.contracts;
  const manifest = {
    runId: "scheduler-wave-dependencies",
    maxConcurrency: 3,
    dependencies: [{ before: "api", after: "tests" }, { before: "ui", after: "tests" }],
    tasks: [
      { id: "api", status: TASK_STATUS.QUEUED },
      { id: "ui", status: TASK_STATUS.QUEUED },
      { id: "tests", status: TASK_STATUS.QUEUED },
      { id: "docs", status: TASK_STATUS.QUEUED },
    ],
  };

  const firstWave = multitask.scheduler.planSchedule(manifest, { now: "2026-05-28T12:00:00.000Z" });
  assert.deepEqual(firstWave.dependencyWaves, [["api", "ui", "docs"], ["tests"]]);
  assert.deepEqual(firstWave.selectedTaskIds, ["api", "ui", "docs"]);
  assert.equal(firstWave.updates.find((update) => update.taskId === "tests").toStatus, TASK_STATUS.BLOCKED);

  const strictPolicy = {
    ...manifest,
    maxConcurrency: 1,
    tasks: [
      { id: "api", status: TASK_STATUS.READY_FOR_REVIEW },
      { id: "tests", status: TASK_STATUS.QUEUED },
    ],
    dependencies: [{ before: "api", after: "tests" }],
  };
  const blocked = multitask.scheduler.planSchedule(strictPolicy, {
    now: "2026-05-28T12:01:00.000Z",
    dependencyReadyStatuses: [TASK_STATUS.READY_TO_MERGE],
  });
  assert.deepEqual(blocked.selectedTaskIds, []);
  assert.deepEqual(blocked.updates.find((update) => update.taskId === "tests").patch.blockedBy, ["api"]);

  const readyToMerge = {
    ...strictPolicy,
    tasks: strictPolicy.tasks.map((task) => task.id === "api" ? { ...task, status: TASK_STATUS.READY_TO_MERGE } : task),
  };
  const unblocked = multitask.scheduler.planSchedule(readyToMerge, {
    now: "2026-05-28T12:02:00.000Z",
    dependencyReadyStatuses: [TASK_STATUS.READY_TO_MERGE],
  });
  assert.deepEqual(unblocked.selectedTaskIds, ["tests"]);
});

test("manifest uses normalized configured worktree root", async () => withTempRepo(async (repoRoot, tempRoot) => {
  await initGitFixture(repoRoot);
  await writeFileEnsured(path.join(repoRoot, ".pi", "multitask", "config.json"), JSON.stringify({
    worktrees: { root: "../configured-worktrees" },
  }, null, 2));
  const { manifest } = await multitask.manifest.createRunState({
    runId: "configured-root",
    tasks: [{ id: "api", prompt: "Use configured root." }],
  }, { cwd: repoRoot });
  const expectedRoot = path.resolve(manifest.repoRoot, "../configured-worktrees");
  assert.equal(manifest.worktreeRoot, expectedRoot);
  assert.equal(manifest.tasks[0].worktree, path.join(expectedRoot, "configured-root", "api"));
}));

test("manifest persists multitask_start dependencies and workflow debug information", async () => withTempRepo(async (repoRoot) => {
  const config = {
    path: path.join(repoRoot, ".pi", "multitask", "config.json"),
    raw: {},
    scripts: {},
    defaults: {
      workerStartupScripts: [],
      workerValidationScripts: [],
      integrationStartupScripts: [],
      integrationValidationScripts: [],
    },
    workers: { maxConcurrency: 4 },
  };

  const manifest = await multitask.manifest.buildManifest({
    runId: "workflow-start",
    runName: "Workflow Start",
    baseCommit: "abc123",
    tasks: [
      { id: "api", prompt: "Implement API." },
      { id: "ui", prompt: "Implement UI." },
      { id: "tests", prompt: "Add tests." },
    ],
    dependencies: [{ before: "api", after: "tests" }],
    workflow: {
      kind: "sequence",
      steps: [
        { kind: "parallel", tasks: ["api", "ui"] },
        { kind: "spawn", task: "tests" },
      ],
    },
  }, { repo: { root: repoRoot, branch: "main" }, config });

  assert.deepEqual(manifest.dependencies, [{ before: "api", after: "tests" }, { before: "ui", after: "tests" }]);
  assert.deepEqual(manifest.tasks.find((task) => task.id === "tests").dependencies, ["api", "ui"]);
  assert.equal(manifest.workflow.kind, "pi-multitask-workflow");
  assert.equal(manifest.workflow.tree.kind, "sequence");
  assert.deepEqual(manifest.workflow.waves, [["api", "ui"], ["tests"]]);
  assert.match(manifest.workflow.mermaid, /ui --> tests/);
}));

test("status DTO fixtures cover queued, running, attention, and ready tasks", () => {
  const fixture = multitask.statusFixtures.createMixedRunStatusFixture();
  assert.equal(fixture.kind, "pi-multitask-status");
  assert.equal(fixture.schemaVersion, multitask.contracts.CONTRACT_SCHEMA_VERSION);
  assert.deepEqual(fixture.totals, {
    runs: 1,
    tasks: 5,
    queuedTasks: 1,
    runningTasks: 1,
    attentionTasks: 1,
    readyTasks: 2,
  });

  const run = fixture.runs[0];
  assert.equal(run.kind, "pi-multitask-run-status");
  assert.equal(run.taskCounts.queued, 1);
  assert.equal(run.taskCounts.running, 1);
  assert.equal(run.taskCounts.needs_attention, 1);
  assert.equal(run.taskCounts.ready_for_review, 1);
  assert.equal(run.taskCounts.ready_to_merge, 1);
  assert.equal(run.boardCounts.queued, 1);
  assert.equal(run.boardCounts.running, 1);
  assert.equal(run.boardCounts.attention, 1);
  assert.equal(run.boardCounts.ready, 2);
  assert.equal(run.tasks.find((task) => task.id === "ui").worker.attachmentState, "attached");
  assert.equal(run.tasks.find((task) => task.id === "api").worker.attachmentState, "detached_idle");

  const widget = multitask.tuiState.formatCompactWidgetLines(fixture).join("\n");
  assert.match(widget, /porchestrator: run Fixture Mixed Run · 1 queued · 1 running · 1 attention · 2 ready/);

  const panel = multitask.tuiState.formatPanelLines(fixture).join("\n");
  assert.match(panel, /Queued \(1\)/);
  assert.match(panel, /api\s+queued/);
  assert.match(panel, /Running \(1\)/);
  assert.match(panel, /ui\s+running/);
  assert.match(panel, /Needs attention \(1\)/);
  assert.match(panel, /copy\s+needs attention/);
  assert.match(panel, /Ready \(2\)/);
  assert.match(panel, /docs\s+ready to merge/);

  const detail = multitask.tuiState.formatPanelLines(fixture, { view: "task", runId: run.runId, taskId: "copy" }).join("\n");
  assert.match(detail, /attention\/error: Needs product decision/);
  assert.match(detail, /Views: \[b\] board/);

  const diff = multitask.tuiState.formatPanelLines(fixture, { view: "diff", runId: run.runId, taskId: "tests" }).join("\n");
  assert.match(diff, /Diff summary: tests/);
  assert.match(diff, /test\/api\.test\.js/);

  const review = multitask.tuiState.formatPanelLines(fixture, { view: "review", runId: run.runId, taskId: "docs" }).join("\n");
  assert.match(review, /Review results: docs/);
  assert.match(review, /decision: ready to merge/);

  const integration = multitask.tuiState.formatPanelLines(fixture, { view: "integration", runId: run.runId }).join("\n");
  assert.match(integration, /Integration: Fixture Mixed Run/);
  assert.match(integration, /branch: mt\/fixture-mixed-run\/integration/);
});

test("message DTO fixtures use canonical typed message envelopes", () => {
  const messages = multitask.statusFixtures.createMessageFixture();
  assert.equal(messages.length, 6);
  assert.deepEqual([...new Set(messages.map((message) => message.type))].sort(), [
    "assignment",
    "decision",
    "question",
    "report_blocked",
    "report_done",
    "review_feedback",
  ]);
  const blocked = messages.find((message) => message.type === "report_blocked");
  assert.equal(blocked.kind, "pi-multitask-message");
  assert.equal(blocked.direction, "worker_to_supervisor");
  assert.equal(blocked.correlationId, "decision-copy-tone");
  assert.throws(() => multitask.contracts.createMessageDto({ runId: "r", type: "unknown", text: "bad" }), /message type must be one of/);
});

test("message normalizer preserves simple strings for multitask_message compatibility", () => {
  const envelope = multitask.messages.normalizeSupervisorMessage("hello attached worker", {
    runId: "r1",
    taskId: "api",
    createdAt: "2026-05-28T12:00:00.000Z",
  });

  assert.equal(envelope.kind, "pi-multitask-message-envelope");
  assert.equal(envelope.isTyped, false);
  assert.equal(envelope.type, "inform");
  assert.equal(envelope.mode, "followUp");
  assert.equal(envelope.text, "hello attached worker");
  assert.equal(envelope.prompt, "hello attached worker");
  assert.deepEqual(envelope.transport, { message: "hello attached worker", mode: "followUp" });
  assert.equal(envelope.dto.kind, "pi-multitask-message");
});

test("typed decision and review feedback messages format clear worker follow-up prompts", () => {
  const decision = multitask.messages.normalizeSupervisorMessage({
    runId: "r1",
    taskId: "copy",
    type: "decision",
    mode: "follow_up",
    correlationId: "decision-copy-tone",
    message: "Use concise formal copy.",
    payload: { question: "Should the empty state be playful or formal?", rationale: "Product wants consistency." },
  });

  assert.equal(decision.isTyped, true);
  assert.equal(decision.dto.type, "decision");
  assert.equal(decision.dto.mode, "followUp");
  assert.equal(decision.dto.correlationId, "decision-copy-tone");
  assert.match(decision.prompt, /Porchestrator decision from supervisor/);
  assert.match(decision.prompt, /Correlation ID: decision-copy-tone/);
  assert.match(decision.prompt, /Question\/request being answered:\nShould the empty state be playful or formal\?/);
  assert.match(decision.prompt, /Decision:\nUse concise formal copy\./);
  assert.match(decision.prompt, /resume work and send a report_done message/);

  const feedback = multitask.messages.normalizeSupervisorMessage({
    runId: "r1",
    taskId: "docs",
    type: "review_feedback",
    correlationId: "review-docs-1",
    message: "Deterministic review found two blocking issues.",
    payload: {
      decision: "needs_changes",
      actionItems: ["Add the missing CLI example.", "Rerun npm run test:multitask-no-credit."],
      validation: { ok: false, summary: "No test output attached." },
    },
  });

  assert.equal(feedback.dto.type, "review_feedback");
  assert.match(feedback.prompt, /Porchestrator review feedback from supervisor/);
  assert.match(feedback.prompt, /Review decision: needs_changes/);
  assert.match(feedback.prompt, /Action items:\n- Add the missing CLI example\./);
  assert.match(feedback.prompt, /Validation:\n- Status: failed\n- Summary: No test output attached\./);
  assert.match(feedback.prompt, /Please address the feedback/);
});

test("worker need_decision and report_blocked reports normalize into attention transitions", () => {
  const decisionReport = multitask.messages.normalizeWorkerReport({
    runId: "r1",
    taskId: "copy",
    type: "report_blocked",
    reason: "need_decision",
    summary: "Should the empty state be playful or formal?",
    changed_files: ["src/copy.ts"],
    validation: "Not run; waiting on copy tone.",
    correlationId: "decision-copy-tone",
  });

  assert.equal(decisionReport.kind, "pi-multitask-worker-report");
  assert.equal(decisionReport.status, "needs_attention");
  assert.equal(decisionReport.reason, "need_decision");
  assert.deepEqual(decisionReport.changedFiles, ["src/copy.ts"]);
  assert.deepEqual(decisionReport.validation, { summary: "Not run; waiting on copy tone." });

  const transition = multitask.messages.workerReportToTaskTransition(decisionReport, { fromStatus: "running", now: "2026-05-28T12:01:00.000Z" });
  assert.equal(transition.status, "needs_attention");
  assert.equal(transition.needsAttention, true);
  assert.equal(transition.patch.status, "needs_attention");
  assert.equal(transition.patch.error, "Should the empty state be playful or formal?");
  assert.deepEqual(transition.patch.attention, {
    reason: "need_decision",
    summary: "Should the empty state be playful or formal?",
    question: "Should the empty state be playful or formal?",
    correlationId: "decision-copy-tone",
  });

  const needDecision = multitask.messages.normalizeWorkerReport("need_decision: Should I keep the old API shim?", { runId: "r1", taskId: "api" });
  assert.equal(needDecision.status, "needs_attention");
  assert.equal(needDecision.reason, "need_decision");
  assert.equal(multitask.messages.workerReportToTaskTransition(needDecision).status, "needs_attention");

  const prefixed = multitask.messages.normalizeWorkerReport("report_blocked: Waiting on API contract from another task.", { runId: "r1", taskId: "ui" });
  assert.equal(prefixed.status, "blocked");
  assert.equal(prefixed.reason, "blocked");
  assert.equal(multitask.messages.workerReportToTaskTransition(prefixed).status, "blocked");
  assert.match(multitask.messages.formatWorkerReportForSupervisor(decisionReport), /copy needs a supervisor decision/);
});

test("worker report parser accepts JSON and key-value done reports without live workers", () => {
  const json = multitask.messages.normalizeWorkerReport(`\n\`\`\`json\n{\n  "status": "ready_for_review",\n  "reason": "done",\n  "summary": "Implemented the API card.",\n  "changedFiles": ["src/api.js", "test/api.test.js"],\n  "validation": { "ok": true, "summary": "npm test passed" }\n}\n\`\`\`\n`, { runId: "r1", taskId: "api" });
  assert.equal(json.status, "ready_for_review");
  assert.equal(json.reason, "done");
  assert.deepEqual(json.changedFiles, ["src/api.js", "test/api.test.js"]);
  assert.deepEqual(json.validation, { status: "passed", summary: "npm test passed", command: undefined, checks: undefined, raw: undefined });
  assert.equal(multitask.messages.workerReportToTaskTransition(json).status, "ready_for_review");

  const keyValue = multitask.messages.normalizeWorkerReport("Status: ready_for_review\nReason: done\nSummary: Tests are ready.\nChanged files:\n- test/api.test.js", { runId: "r1", taskId: "tests" });
  assert.equal(keyValue.status, "ready_for_review");
  assert.deepEqual(keyValue.changedFiles, ["test/api.test.js"]);

  assert.equal(multitask.messages.tryParseWorkerReport("ordinary progress note"), undefined);
});

test("event jsonl readers preserve malformed entries without throwing", async () => withTempRepo(async (repoRoot) => {
  const file = path.join(repoRoot, ".pi", "multitask", "events.jsonl");
  await multitask.events.appendJsonLine(file, { type: "ok", value: 1 });
  await fs.appendFile(file, "{bad json\n", "utf8");
  const events = await multitask.events.readJsonLines(file);
  assert.equal(events[0].type, "ok");
  assert.equal(events[1].type, "malformed_event");
}));

test("diff parsers and formatters are pure no-credit helpers", () => {
  assert.deepEqual(multitask.diff.parseNameStatus("M\tsrc/a.js\nR100\told.js\tnew.js\n", "committed"), [
    { path: "src/a.js", oldPath: undefined, status: "M", source: "committed" },
    { path: "new.js", oldPath: "old.js", status: "R100", source: "committed" },
  ]);
  assert.deepEqual(multitask.diff.parsePorcelainStatusZ(" M src/a.js\0R  new.js\0old.js\0"), [
    { path: "src/a.js", status: " M", source: "worktree" },
    { path: "new.js", oldPath: "old.js", status: "R ", source: "worktree" },
  ]);
  const merged = multitask.diff.mergeChangedFiles(
    [{ path: "a", status: "M", source: "committed" }],
    [{ path: "a", status: " M", source: "worktree" }, { path: "b", status: "A", source: "staged" }],
  );
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].sources, ["committed", "worktree"]);
});

test("tui state formats active runs, panels, transcript tails, and daemon status text", () => {
  const transcript = Array.from({ length: 5 }, (_, index) => ({
    time: `2026-05-28T12:0${index}:00.000Z`,
    kind: "message",
    role: index % 2 ? "assistant" : "user",
    text: `transcript entry ${index}`,
  }));
  const state = multitask.tuiState.createTuiState({
    runs: [{
      runId: "r1",
      status: "running",
      integration: { status: "idle", branch: "mt/r1/integration" },
      tasks: [{
        id: "api",
        status: "ready_for_review",
        diff: { changedFiles: ["a"], summary: "1 file changed", patch: "full patch must not render" },
        transcriptTail: transcript,
      }],
    }],
  }, { now: "now" });
  assert.equal(state.totals.activeRuns, 1);
  assert.match(multitask.tuiState.formatCompactWidgetLines(state).join("\n"), /porchestrator: run r1 · 1 ready/);
  assert.match(multitask.tuiState.formatPanelLines(state).join("\n"), /api\s+ready for review/);

  const tail = multitask.tuiState.formatTranscriptTailLines(state.runs[0].tasks[0], { maxEntries: 2 }).join("\n");
  assert.match(tail, /Showing last 2 entries only/);
  assert.doesNotMatch(tail, /transcript entry 0/);
  assert.match(tail, /transcript entry 4/);
  assert.match(tail, /Full logs are not dumped into model context/);

  const diff = multitask.tuiState.formatDiffSummaryLines(state.runs[0].tasks[0]).join("\n");
  assert.match(diff, /1 file changed/);
  assert.match(diff, /Full patches are intentionally not rendered/);
  assert.doesNotMatch(diff, /full patch must not render/);

  assert.match(multitask.lifecycle.formatDaemonStatus({ status: "stale", pid: 999999, pidAlive: false, socketExists: true, socketReachable: false, stalePid: true, staleSocket: true, socketPath: "/tmp/x" }), /cleanup available/);
});

test("stale daemon pid/socket helpers detect and remove stale files only", async () => withTempRepo(async (repoRoot) => {
  await fs.mkdir(path.join(repoRoot, ".pi", "multitask"), { recursive: true });
  const pidPath = multitask.manifest.daemonPidPath(repoRoot);
  const socketPath = multitask.manifest.daemonSocketPath(repoRoot);
  await fs.writeFile(pidPath, "999999999\n", "utf8");
  await fs.writeFile(socketPath, "stale socket placeholder", "utf8");

  const status = await multitask.lifecycle.getDaemonStatus(repoRoot, { timeoutMs: 10 });
  assert.equal(status.status, "stale");
  assert.equal(status.stalePid, true);

  const cleanup = await multitask.lifecycle.cleanupStaleDaemonFiles(repoRoot, { status });
  assert.equal(cleanup.removed.length, 2);
  await assert.rejects(fs.access(pidPath));
  await assert.rejects(fs.access(socketPath));

  await fs.writeFile(pidPath, `${process.pid}\n`, "utf8");
  const live = await multitask.lifecycle.getDaemonStatus(repoRoot, { timeoutMs: 10 });
  assert.equal(live.pidAlive, true);
  const skipped = await multitask.lifecycle.cleanupStaleDaemonFiles(repoRoot, { status: live });
  assert.equal(skipped.removed.length, 0);
  await fs.access(pidPath);
}));

test("cleanup target collection and dry-run do not remove files or require git worktrees", async () => withTempRepo(async (repoRoot) => {
  const manifest = fixtureManifest(repoRoot);
  await multitask.manifest.initializeRunState(repoRoot, manifest, { planMarkdown: "# plan\n" });
  await fs.mkdir(manifest.tasks[0].worktree, { recursive: true });
  await fs.writeFile(path.join(manifest.tasks[0].worktree, "note.txt"), "not a git worktree\n", "utf8");

  const targets = multitask.cleanup.collectCleanupTargets(manifest, { removeState: true });
  assert.equal(targets.worktrees.length, 2);
  assert.equal(targets.state.length, 1);

  const result = await multitask.cleanup.cleanupMultitaskRun({ runId: manifest.runId, removeState: true, dryRun: true }, { repo: { root: repoRoot }, manifest });
  assert.equal(result.dryRun, true);
  assert.match(result.summary, /Dry run only/);
  await fs.access(manifest.tasks[0].worktree);
  await fs.access(manifest.stateDir);
}));

test("doctor reports stale daemon, dirty checkout, and lost running workers without starting pi", async () => withTempRepo(async (repoRoot) => {
  const manifest = fixtureManifest(repoRoot, {
    status: "running",
    tasks: [{
      ...fixtureManifest(repoRoot).tasks[0],
      status: "running",
      worker: { activityStatus: "running", pid: 999999 },
    }],
  });
  await multitask.manifest.initializeRunState(repoRoot, manifest, { planMarkdown: "# plan\n" });
  await fs.mkdir(path.dirname(multitask.manifest.multitaskConfigPath(repoRoot)), { recursive: true });
  await fs.writeFile(multitask.manifest.multitaskConfigPath(repoRoot), JSON.stringify({ workers: { runner: "mock" } }), "utf8");

  const staleDaemon = {
    repoRoot,
    pidPath: multitask.manifest.daemonPidPath(repoRoot),
    socketPath: multitask.manifest.daemonSocketPath(repoRoot),
    pidPathExists: true,
    pid: 999999,
    pidAlive: false,
    socketExists: true,
    socketReachable: false,
    stalePid: true,
    staleSocket: true,
    status: "stale",
  };
  const runGit = async (_cwd, args) => {
    const joined = args.join(" ");
    if (joined === "rev-parse --is-inside-work-tree") return { exitCode: 0, stdout: "true\n", stderr: "" };
    if (joined === "worktree list --porcelain") return { exitCode: 0, stdout: `worktree ${repoRoot}\n`, stderr: "" };
    if (joined === "status --porcelain --untracked-files=all") return { exitCode: 0, stdout: " M package.json\n?? scratch.txt\n", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const report = await multitask.doctor.runDoctor({}, {
    repo: { root: repoRoot, branch: "main", baseCommit: "abc123" },
    runGit,
    getDaemonStatus: async () => staleDaemon,
  });
  assert.equal(report.status, "warn");
  assert.equal(report.checks.find((check) => check.id === "pi-rpc").status, "pass");
  assert.equal(report.checks.find((check) => check.id === "daemon-socket").status, "warn");
  assert.equal(report.checks.find((check) => check.id === "foreground-checkout").status, "warn");
  assert.equal(report.checks.find((check) => check.id === "worker-recovery").status, "warn");
  const formatted = multitask.doctor.formatDoctorReport(report);
  assert.match(formatted, /Commit, stash, or discard/);
  assert.match(formatted, /stale daemon/i);
  assert.match(formatted, /marked running without a live daemon worker handle/);
}));

test("run export bundles manifest, plan, events, transcripts, reviews, diffs, and integration metadata offline", async () => withTempRepo(async (repoRoot) => {
  const manifest = fixtureManifest(repoRoot, { status: "ready_for_review" });
  await multitask.manifest.initializeRunState(repoRoot, manifest, { planMarkdown: "# Export plan\n" });
  await multitask.events.initializeEventFiles(repoRoot, manifest);
  await multitask.events.appendTranscriptEvent(repoRoot, manifest.runId, "api", { role: "assistant", text: "done" });
  await fs.writeFile(multitask.manifest.taskReviewPath(repoRoot, manifest.runId, "api"), "# Review\nLooks good.\n", "utf8");

  const bundle = await multitask.export.exportMultitaskRun({ runId: manifest.runId, write: false }, {
    repo: { root: repoRoot },
    manifest,
    getDiff: async () => ({
      runId: manifest.runId,
      targets: [
        { targetId: "api", targetType: "task", changedFiles: [{ path: "src/a.js", status: "M" }] },
        { targetId: "integration", targetType: "integration", changedFiles: [] },
      ],
      summary: "mock diff",
    }),
  });

  assert.equal(bundle.kind, "pi-multitask-run-export");
  assert.equal(bundle.manifest.runId, manifest.runId);
  assert.match(bundle.plan.markdown, /Export plan/);
  assert.ok(bundle.events.entries.length >= 1);
  assert.equal(bundle.transcripts.api[0].text, "done");
  assert.match(bundle.reviews.api.markdown, /Looks good/);
  assert.equal(bundle.diffs.targets[0].targetId, "api");
  assert.equal(bundle.integration.diff.targetId, "integration");
  assert.equal(bundle.outputPath, undefined);
  assert.match(multitask.export.formatRunExportSummary(bundle), /manifest: yes/);
}));

test("prune previews destructive targets and requires confirmation before deleting", async () => withTempRepo(async (repoRoot) => {
  const manifest = fixtureManifest(repoRoot, { status: "merged" });
  await multitask.manifest.initializeRunState(repoRoot, manifest, { planMarkdown: "# plan\n" });
  await fs.mkdir(manifest.tasks[0].worktree, { recursive: true });
  await fs.writeFile(path.join(manifest.tasks[0].worktree, "note.txt"), "temporary worktree\n", "utf8");

  const preview = await multitask.prune.pruneMultitask({ removeState: true }, { repo: { root: repoRoot }, runs: [manifest] });
  assert.equal(preview.dryRun, true);
  assert.match(preview.summary, /Dry run only/);
  assert.equal(preview.runs[0].worktrees[0].status, "planned");
  await fs.access(manifest.tasks[0].worktree);
  await fs.access(manifest.stateDir);

  const blocked = await multitask.prune.pruneMultitask({ removeState: true, dryRun: false }, { repo: { root: repoRoot }, runs: [manifest] });
  assert.equal(blocked.dryRun, true);
  assert.equal(blocked.requiresConfirmation, true);
  assert.equal(blocked.requiredConfirmation, `delete ${manifest.runId}`);
  await fs.access(manifest.tasks[0].worktree);

  const deleted = await multitask.prune.pruneMultitask({
    removeState: true,
    dryRun: false,
    confirm: `delete ${manifest.runId}`,
    gitWorktreeRemove: false,
  }, { repo: { root: repoRoot }, runs: [manifest] });
  assert.equal(deleted.dryRun, false);
  assert.equal(deleted.runs[0].worktrees[0].status, "removed");
  await assert.rejects(fs.access(manifest.tasks[0].worktree));
  await assert.rejects(fs.access(manifest.stateDir));
}));

test("spawn provisioning appends a task with worktree and session metadata without starting pi", async () => withTempRepo(async (repoRoot) => {
  const manifest = fixtureManifest(repoRoot, { status: "queued" });
  await multitask.manifest.initializeRunState(repoRoot, manifest, { planMarkdown: "# plan\n" });
  await multitask.events.initializeEventFiles(repoRoot, manifest);

  await fs.mkdir(path.dirname(multitask.manifest.multitaskConfigPath(repoRoot)), { recursive: true });
  await fs.writeFile(multitask.manifest.multitaskConfigPath(repoRoot), JSON.stringify({
    scripts: {
      prep: {
        command: "node -e \"require('node:fs').writeFileSync('spawned.txt', process.env.PI_MULTITASK_TASK_ID)\"",
      },
      check: {
        command: "node -e \"process.exit(0)\"",
      },
    },
  }, null, 2), "utf8");

  const createWorktreeCalls = [];
  const result = await multitask.spawn.spawnTasks({
    runId: manifest.runId,
    task: {
      id: "UI Card",
      prompt: "Implement the UI card.",
      agent: "reviewer",
      startupScripts: ["prep"],
      validationScripts: ["check"],
    },
  }, {
    repo: { root: repoRoot },
    createWorktree: async (repo, worktree, branch, baseRef) => {
      createWorktreeCalls.push({ repo, worktree, branch, baseRef });
      await fs.mkdir(worktree, { recursive: true });
    },
  });

  assert.equal(result.runStatus.kind, "pi-multitask-run-status");
  assert.deepEqual(result.taskIds, ["ui-card"]);
  assert.equal(result.taskStatuses[0].status, "queued");
  assert.equal(result.taskStatuses[0].worker.sessionDir, result.tasks[0].paths.session);
  assert.equal(createWorktreeCalls.length, 1);
  assert.equal(createWorktreeCalls[0].branch, "mt/phase-6/ui-card");
  assert.equal(createWorktreeCalls[0].baseRef, "HEAD");

  const savedManifest = await multitask.manifest.loadManifest(repoRoot, manifest.runId);
  assert.equal(savedManifest.tasks.length, 2);
  const spawned = savedManifest.tasks.find((task) => task.id === "ui-card");
  assert.equal(spawned.status, "queued");
  assert.equal(spawned.agent, "reviewer");
  assert.equal(spawned.branch, "mt/phase-6/ui-card");
  assert.equal(spawned.worktree, path.join(savedManifest.worktreeRoot, manifest.runId, "ui-card"));
  assert.equal(spawned.paths.session, multitask.manifest.taskSessionDir(repoRoot, manifest.runId, "ui-card"));
  assert.deepEqual(spawned.startupScripts, ["prep"]);
  assert.deepEqual(spawned.validationScripts, ["check"]);
  assert.equal(spawned.startupResults[0].status, "succeeded");

  const state = await multitask.manifest.loadTaskState(repoRoot, manifest.runId, "ui-card");
  assert.equal(state.worker.sessionDir, spawned.paths.session);
  await fs.access(spawned.paths.session);
  assert.equal(await fs.readFile(path.join(spawned.worktree, "spawned.txt"), "utf8"), "ui-card");

  const events = await multitask.events.readTaskEvents(repoRoot, manifest.runId, "ui-card");
  assert.ok(events.some((event) => event.type === "task_created"));
  assert.ok(events.some((event) => event.type === "task_worktree_ready"));
  assert.ok(events.some((event) => event.type === "task_status_changed" && event.status === "queued"));
}));

test("spawn provisioning rejects duplicate ids and unknown scripts before mutating the run", async () => withTempRepo(async (repoRoot) => {
  const manifest = fixtureManifest(repoRoot);
  await multitask.manifest.initializeRunState(repoRoot, manifest, { planMarkdown: "# plan\n" });

  await assert.rejects(
    multitask.spawn.spawnTasks({ runId: manifest.runId, task: { id: "api", prompt: "duplicate" } }, { repo: { root: repoRoot } }),
    /task id already exists/,
  );

  await assert.rejects(
    multitask.spawn.spawnTasks({ runId: manifest.runId, task: { id: "new-task", prompt: "new", startupScripts: ["missing"] } }, { repo: { root: repoRoot } }),
    /Unknown multitask script id "missing"/,
  );

  const saved = await multitask.manifest.loadManifest(repoRoot, manifest.runId);
  assert.deepEqual(saved.tasks.map((task) => task.id), ["api"]);
  await assert.rejects(multitask.manifest.loadTaskState(repoRoot, manifest.runId, "new-task"));
}));

function integrationValidationCommand() {
  return [
    "node -e",
    JSON.stringify("const fs=require('fs');const path=require('path');if(!fs.existsSync('src/spawned.txt')) process.exit(3);fs.appendFileSync(path.join(process.env.PI_MULTITASK_RUN_DIR,'integration-validation.log'),process.env.PI_MULTITASK_WORKTREE_TYPE+':'+process.env.PI_MULTITASK_TASK_ID+'\\n');"),
  ].join(" ");
}

test("merge hardening merges spawned task branches into the integration worktree and runs validation", async () => withTempRepo(async (repoRoot) => {
  await initGitFixture(repoRoot);
  await writeFileEnsured(path.join(repoRoot, ".pi", "multitask", "config.json"), JSON.stringify({
    worktrees: { root: "../worktrees" },
    scripts: {
      "integration-check": {
        command: integrationValidationCommand(),
        timeoutSeconds: 10,
        required: true,
      },
    },
    defaults: {
      integrationValidationScripts: ["integration-check"],
    },
  }, null, 2));
  await execGit(repoRoot, ["add", ".pi/multitask/config.json"]);
  await execGit(repoRoot, ["commit", "-m", "configure multitask validation"]);

  const baseCommit = (await execGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
  const { manifest } = await multitask.manifest.createRunState({
    runId: "merge-spawned",
    runName: "Merge Spawned",
    baseCommit,
    tasks: [{ id: "seed", prompt: "Existing seed task." }],
    integration: { validationScripts: ["integration-check"] },
  }, { cwd: repoRoot });
  await multitask.events.initializeEventFiles(repoRoot, manifest);

  const spawnResult = await multitask.spawn.spawnTasks({
    runId: manifest.runId,
    task: { id: "spawned", prompt: "Create spawned file." },
  }, { cwd: repoRoot });
  const spawned = spawnResult.tasks[0];
  await writeFileEnsured(path.join(spawned.worktree, "src", "spawned.txt"), "from spawned task\n");
  spawned.status = multitask.contracts.TASK_STATUS.READY_TO_MERGE;
  await multitask.manifest.saveTaskState(repoRoot, manifest.runId, spawned);
  const beforeMergeManifest = await multitask.manifest.loadManifest(repoRoot, manifest.runId);
  Object.assign(beforeMergeManifest.tasks.find((task) => task.id === spawned.id), spawned);
  await multitask.manifest.saveManifest(repoRoot, beforeMergeManifest);

  const result = await multitask.merge.mergeTasks({ runId: manifest.runId, taskIds: ["spawned"] }, { cwd: repoRoot });
  assert.equal(result.integration.status, "ready");
  assert.equal(result.merges[0].status, "merged");
  assert.equal(result.integration.validation[0].status, "succeeded");
  assert.match(result.summary, /Integration validation:/);
  assert.match(result.summary, /integration-check: succeeded/);
  await fs.access(path.join(result.integration.worktree, "src", "spawned.txt"));
  assert.equal((await execGit(result.integration.worktree, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim(), result.integration.branch);

  const savedTask = await multitask.manifest.loadTaskState(repoRoot, manifest.runId, "spawned");
  assert.equal(savedTask.status, "merged");
  assert.equal(savedTask.lastMergePreparation.checkpoint, true);
  assert.equal(savedTask.lastMergePreparation.committed, true);
  assert.ok(savedTask.lastMergePreparation.commit);
  assert.equal(await fs.readFile(path.join(repoRoot, ".pi", "multitask", "runs", manifest.runId, "integration-validation.log"), "utf8"), "integration:integration\n");
}));

test("apply hardening requires explicit approval and a clean foreground checkout by default", async () => withTempRepo(async (repoRoot) => {
  const foregroundBranch = await initGitFixture(repoRoot);
  await execGit(repoRoot, ["checkout", "-b", "mt/apply-hardening/integration"]);
  await writeFileEnsured(path.join(repoRoot, "src", "applied.txt"), "integration change\n");
  await execGit(repoRoot, ["add", "."]);
  await execGit(repoRoot, ["commit", "-m", "integration change"]);
  await execGit(repoRoot, ["checkout", foregroundBranch]);

  const manifest = fixtureManifest(repoRoot, {
    runId: "apply-hardening",
    status: "merged",
    integration: {
      id: "integration",
      status: "ready",
      branch: "mt/apply-hardening/integration",
      worktree: path.join(repoRoot, "../worktrees", "apply-hardening", "integration"),
      startupScripts: [],
      validationScripts: [],
      validation: [],
    },
  });
  await multitask.manifest.initializeRunState(repoRoot, manifest, { planMarkdown: "# apply\n" });
  await execGit(repoRoot, ["add", ".pi/multitask/runs/apply-hardening"]);
  await execGit(repoRoot, ["commit", "-m", "record apply-hardening state"]);

  await assert.rejects(
    multitask.merge.applyIntegration({ runId: manifest.runId }, { cwd: repoRoot }),
    /requires explicit user approval/,
  );

  await fs.writeFile(path.join(repoRoot, "dirty.txt"), "dirty\n", "utf8");
  await assert.rejects(
    multitask.merge.applyIntegration({ runId: manifest.runId, approved: true }, { cwd: repoRoot }),
    /refuses unsafe foreground checkouts by default/,
  );
  await fs.rm(path.join(repoRoot, "dirty.txt"), { force: true });

  const result = await multitask.merge.applyIntegration({ runId: manifest.runId, approved: true }, { cwd: repoRoot });
  assert.equal(result.apply.status, "applied");
  assert.equal(result.integration.status, "applied");
  assert.equal(await fs.readFile(path.join(repoRoot, "src", "applied.txt"), "utf8"), "integration change\n");
}));

test("cleanup hardening removes worktrees and prunes git metadata without orphaning normal cleanup paths", async () => withTempRepo(async (repoRoot) => {
  await initGitFixture(repoRoot);
  const baseCommit = (await execGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
  const { manifest } = await multitask.manifest.createRunState({
    runId: "cleanup-hardening",
    runName: "Cleanup Hardening",
    baseCommit,
    worktreeRoot: path.join(path.dirname(repoRoot), "worktrees"),
    tasks: [{ id: "api", prompt: "API." }],
  }, { cwd: repoRoot });
  const task = manifest.tasks[0];
  await multitask.spawn.prepareTaskWorktree(repoRoot, task.worktree, task.branch, "HEAD");
  await multitask.merge.ensureIntegrationWorktree(repoRoot, await require("../src/config.js").loadConfig(repoRoot), manifest, {});
  await multitask.manifest.saveManifest(repoRoot, manifest);

  const cleanup = await multitask.cleanup.cleanupMultitaskRun({ runId: manifest.runId, dryRun: false }, { cwd: repoRoot });
  assert.equal(cleanup.worktrees.filter((entry) => entry.status === "removed").length, 2);
  assert.equal(cleanup.worktreePrune.status, "succeeded");
  const list = await execGit(repoRoot, ["worktree", "list", "--porcelain"]);
  assert.doesNotMatch(list.stdout, new RegExp(task.worktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(list.stdout, new RegExp(manifest.integration.worktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}));

test("daemon spawn uses provisioning plus scheduler and enforces maxConcurrency", async () => withTempRepo(async (repoRoot) => {
  const manifest = fixtureManifest(repoRoot, { status: "queued", maxConcurrency: 1 });
  manifest.tasks[0].status = multitask.contracts.TASK_STATUS.QUEUED;
  await multitask.manifest.initializeRunState(repoRoot, manifest, { planMarkdown: "# plan\n" });
  await multitask.events.initializeEventFiles(repoRoot, manifest);

  const daemon = multitask.daemon.createDaemon({
    repoRoot,
    attachProcessCleanup: false,
    workerSessionOptions: {
      spawn: () => createFakePiProcess(),
      piCommand: "fake-pi",
      responseTimeoutMs: 500,
      initialPromptTimeoutMs: 500,
    },
  });

  try {
    const result = await daemon.spawnIntoRun({
      runId: manifest.runId,
      task: { id: "ui", prompt: "Implement UI." },
      provisionWorktrees: false,
    });
    assert.deepEqual(result.taskIds, ["ui"]);
    assert.deepEqual(result.started.map((entry) => entry.taskId), ["api"]);
    const saved = await multitask.manifest.loadManifest(repoRoot, manifest.runId);
    assert.equal(saved.tasks.find((task) => task.id === "api").status, multitask.contracts.TASK_STATUS.RUNNING);
    assert.equal(saved.tasks.find((task) => task.id === "ui").status, multitask.contracts.TASK_STATUS.QUEUED);
    assert.equal(daemon.workerSessions.size, 1);

    const sent = await daemon.messageWorker({ runId: manifest.runId, taskId: "api", message: "hello worker" });
    assert.equal(sent.command, "follow_up");
    assert.equal(sent.message.text, "hello worker");
    assert.equal(sent.message.type, "inform");

    const typed = await daemon.messageWorker({
      runId: manifest.runId,
      taskId: "api",
      message: "Use the compact copy.",
      type: "decision",
      correlationId: "decision-1",
    });
    assert.equal(typed.message.type, "decision");
    assert.equal(typed.message.correlationId, "decision-1");
  } finally {
    await daemon.stop();
  }
}));

test("daemon status applies recovery classification for stale running workers", async () => withTempRepo(async (repoRoot) => {
  const manifest = fixtureManifest(repoRoot);
  const task = manifest.tasks[0];
  task.status = multitask.contracts.TASK_STATUS.RUNNING;
  task.worker = {
    pid: 987654,
    processStatus: "running",
    activityStatus: "running",
    startedAt: "2026-05-28T12:00:00.000Z",
    sessionDir: task.paths.session,
  };
  await multitask.manifest.initializeRunState(repoRoot, manifest, { planMarkdown: "# plan\n" });

  const daemon = multitask.daemon.createDaemon({ repoRoot, attachProcessCleanup: false });
  const status = await daemon.dispatch(multitask.protocol.METHODS.STATUS, { runId: manifest.runId });
  assert.equal(status.recovery.staleRunningTasks.length, 1);
  assert.equal(status.manifest.tasks[0].status, multitask.contracts.TASK_STATUS.NEEDS_ATTENTION);
  assert.equal(status.manifest.tasks[0].worker.attachmentState, multitask.contracts.WORKER_ATTACHMENT_STATE.LOST_RUNNING);
  assert.match(status.summary, /lost running/);
}));

test("daemon resume restarts detached idle worker sessions from persisted session directories", async () => withTempRepo(async (repoRoot) => {
  const manifest = fixtureManifest(repoRoot);
  const task = manifest.tasks[0];
  task.status = multitask.contracts.TASK_STATUS.IDLE;
  task.worker = {
    processStatus: "exited",
    activityStatus: "idle",
    startedAt: "2026-05-28T12:00:00.000Z",
    exitedAt: "2026-05-28T12:05:00.000Z",
    sessionDir: task.paths.session,
  };
  await multitask.manifest.initializeRunState(repoRoot, manifest, { planMarkdown: "# plan\n" });
  await fs.writeFile(path.join(task.paths.session, "session.json"), "{}\n", "utf8");

  const daemon = multitask.daemon.createDaemon({
    repoRoot,
    attachProcessCleanup: false,
    workerSessionOptions: {
      spawn: () => createFakePiProcess(),
      piCommand: "fake-pi",
      responseTimeoutMs: 500,
    },
  });

  try {
    const resumed = await daemon.resumeWorker({ runId: manifest.runId, taskId: task.id, message: "continue please" });
    assert.equal(resumed.results.length, 1);
    assert.equal(resumed.results[0].restarted, true);
    assert.equal(resumed.results[0].messageResult.command, "prompt");
    assert.equal(daemon.workerSessions.size, 1);
  } finally {
    await daemon.stop();
  }
}));

test("recovery detects stale running tasks after a daemon restart", async () => withTempRepo(async (repoRoot) => {
  const manifest = fixtureManifest(repoRoot);
  const task = manifest.tasks[0];
  task.status = multitask.contracts.TASK_STATUS.RUNNING;
  task.worker = {
    pid: 987654,
    processStatus: "running",
    activityStatus: "running",
    startedAt: "2026-05-28T12:00:00.000Z",
    sessionDir: task.paths.session,
  };
  await multitask.manifest.initializeRunState(repoRoot, manifest, { planMarkdown: "# plan\n" });

  const report = await multitask.recovery.analyzeRunRecovery(manifest, { workerSessions: new Map() });
  assert.equal(report.staleRunningTasks.length, 1);
  assert.equal(report.staleRunningTasks[0].taskId, "api");
  assert.equal(report.staleRunningTasks[0].attachmentState, multitask.contracts.WORKER_ATTACHMENT_STATE.LOST_RUNNING);
  assert.equal(report.staleRunningTasks[0].restartPolicy.updateStatusTo, multitask.contracts.TASK_STATUS.NEEDS_ATTENTION);
  assert.match(multitask.recovery.formatRecoverySuggestions(report), /no live worker handle is attached/);

  const stale = await multitask.recovery.detectStaleRunningTasks(manifest, { workerSessions: new Map() });
  assert.deepEqual(stale.map((item) => item.taskId), ["api"]);
}));

test("recovery identifies detached idle workers from persisted session state", async () => withTempRepo(async (repoRoot) => {
  const manifest = fixtureManifest(repoRoot);
  const task = manifest.tasks[0];
  task.status = multitask.contracts.TASK_STATUS.IDLE;
  task.worker = {
    processStatus: "exited",
    activityStatus: "idle",
    startedAt: "2026-05-28T12:00:00.000Z",
    exitedAt: "2026-05-28T12:05:00.000Z",
    sessionDir: task.paths.session,
  };
  await multitask.manifest.initializeRunState(repoRoot, manifest, { planMarkdown: "# plan\n" });
  await fs.writeFile(path.join(task.paths.session, "session.json"), JSON.stringify({ id: "persisted" }), "utf8");

  const classification = await multitask.recovery.classifyTaskRecovery(task, { manifest, repoRoot });
  assert.equal(classification.attachmentState, multitask.contracts.WORKER_ATTACHMENT_STATE.DETACHED_IDLE);
  assert.equal(classification.hasPersistedSessionState, true);
  assert.equal(classification.canRestart, true);
  assert.equal(classification.restartPolicy.action, "restart_from_session");
  assert.match(classification.suggestions.join("\n"), /persisted idle worker state/);
}));

test("recovery classifies attached and completed worker states with canonical names", async () => withTempRepo(async (repoRoot) => {
  const manifest = fixtureManifest(repoRoot);
  const task = manifest.tasks[0];
  task.status = multitask.contracts.TASK_STATUS.RUNNING;
  task.worker = { sessionDir: task.paths.session };
  await multitask.manifest.initializeRunState(repoRoot, manifest, { planMarkdown: "# plan\n" });

  const attachedSession = {
    isAlive: true,
    isRunning: true,
    getStatus: () => ({ isAlive: true, isRunning: true, processStatus: "running", activityStatus: "running", pid: 123, sessionDir: task.paths.session }),
  };
  const attached = await multitask.recovery.classifyTaskRecovery(task, { manifest, repoRoot, session: attachedSession });
  assert.equal(attached.attachmentState, multitask.contracts.WORKER_ATTACHMENT_STATE.ATTACHED);
  assert.equal(attached.worker.pid, 123);

  const completed = await multitask.recovery.classifyTaskRecovery({
    ...task,
    status: multitask.contracts.TASK_STATUS.READY_FOR_REVIEW,
    worker: { processStatus: "exited", activityStatus: "idle", sessionDir: task.paths.session },
  }, { manifest, repoRoot });
  assert.equal(completed.attachmentState, multitask.contracts.WORKER_ATTACHMENT_STATE.COMPLETED);
  assert.equal(completed.restartPolicy.action, "restart_for_followup");
}));

test("restartIfNeeded restarts detached mock sessions and sends follow-up messages", async () => withTempRepo(async (repoRoot) => {
  const manifest = fixtureManifest(repoRoot);
  const task = manifest.tasks[0];
  task.status = multitask.contracts.TASK_STATUS.IDLE;
  task.worker = {
    processStatus: "exited",
    activityStatus: "idle",
    startedAt: "2026-05-28T12:00:00.000Z",
    exitedAt: "2026-05-28T12:05:00.000Z",
    sessionDir: task.paths.session,
  };
  await multitask.manifest.initializeRunState(repoRoot, manifest, { planMarkdown: "# plan\n" });
  await fs.writeFile(path.join(task.paths.session, "session.json"), "{}\n", "utf8");

  const registry = new Map();
  const calls = [];
  const mockSession = {
    isAlive: false,
    async start() {
      calls.push("start");
      this.isAlive = true;
      this.isIdle = true;
    },
    getStatus() {
      return { isAlive: this.isAlive, isIdle: this.isIdle, processStatus: this.isAlive ? "running" : "new", activityStatus: "idle", sessionDir: task.paths.session };
    },
  };

  const result = await multitask.recovery.restartIfNeeded({
    manifest,
    task,
    repoRoot,
    workerSessions: registry,
    restartIfNeeded: true,
    message: "Please continue with the follow-up.",
    mode: "followUp",
  }, {
    createSession: async (sessionInput) => {
      calls.push({ createSession: sessionInput.sessionDir });
      return mockSession;
    },
    sendMessage: async (session, message, options) => {
      calls.push({ sendMessage: message, mode: options.mode, alive: session.isAlive });
      return { command: "prompt", response: { success: true } };
    },
  });

  assert.equal(result.restarted, true);
  assert.equal(result.action, "restart_from_session");
  assert.equal(result.messageResult.command, "prompt");
  assert.equal(registry.get(multitask.rpcWorkerSession.workerSessionKey(manifest.runId, task.id)), mockSession);
  assert.deepEqual(calls, [
    { createSession: task.paths.session },
    "start",
    { sendMessage: "Please continue with the follow-up.", mode: "followUp", alive: true },
  ]);
}));

test("restartIfNeeded uses attached mock sessions without restarting", async () => withTempRepo(async (repoRoot) => {
  const manifest = fixtureManifest(repoRoot);
  const task = manifest.tasks[0];
  task.status = multitask.contracts.TASK_STATUS.RUNNING;
  task.worker = { sessionDir: task.paths.session };
  const attachedSession = {
    isAlive: true,
    isIdle: true,
    getStatus: () => ({ isAlive: true, isIdle: true, processStatus: "running", activityStatus: "idle", sessionDir: task.paths.session }),
  };
  const calls = [];

  const result = await multitask.recovery.restartIfNeeded({
    manifest,
    task,
    repoRoot,
    session: attachedSession,
    restartIfNeeded: true,
    message: "hello attached worker",
  }, {
    createSession: async () => {
      calls.push("unexpected-create");
    },
    sendMessage: async (session, message) => {
      calls.push({ message, alive: session.isAlive });
      return { command: "prompt", response: { success: true } };
    },
  });

  assert.equal(result.restarted, false);
  assert.equal(result.action, "use_attached");
  assert.deepEqual(calls, [{ message: "hello attached worker", alive: true }]);
}));

test("mock RpcWorkerSession starts, prompts, records state, and stops without spawning pi", async () => withTempRepo(async (repoRoot) => {
  const manifest = fixtureManifest(repoRoot);
  await multitask.manifest.initializeRunState(repoRoot, manifest, { planMarkdown: "# plan\n" });
  const task = manifest.tasks[0];
  await fs.mkdir(task.worktree, { recursive: true });

  const session = await multitask.rpcWorkerSession.createWorkerSessionForTask({ repoRoot, manifest, task }, {
    spawn: () => createFakePiProcess(),
    piCommand: "fake-pi",
    responseTimeoutMs: 500,
  });
  await session.start();
  assert.equal(session.getStatus().processStatus, "running");

  const prompt = await session.prompt("hello", { timeoutMs: 500 });
  assert.equal(prompt.success, true);
  const state = await session.getState({ timeoutMs: 500 });
  assert.equal(state.isStreaming, false);
  assert.equal(multitask.rpcWorkerSession.chooseMessageCommand(session), "prompt");

  session.handleRpcMessage({ type: "agent_start" });
  assert.equal(session.activityStatus, "running");
  assert.equal(multitask.rpcWorkerSession.chooseMessageCommand(session), "follow_up");
  session.handleRpcMessage({ type: "agent_end", messages: [{ role: "assistant", stopReason: "end_turn" }] });
  assert.equal(session.activityStatus, "idle");

  await session.stop({ timeoutMs: 500 });
  await session.waitForPersistence();
  const saved = await multitask.manifest.loadTaskState(repoRoot, manifest.runId, task.id);
  assert.equal(saved.worker.processStatus, "exited");
  const transcript = await multitask.events.readTranscript(repoRoot, manifest.runId, task.id);
  assert.ok(transcript.some((entry) => entry.kind === "command" && entry.command.type === "prompt"));
}));

test("deterministic review markdown summary stays no-credit", () => {
  const markdown = multitask.review.formatReviewMarkdown({
    manifest: { runId: "r" },
    task: { id: "api", branch: "mt/r/api", worktree: "/tmp/api" },
    diff: { changedFiles: [{ path: "src/a.js", status: "M", sources: ["worktree"] }], summary: "summary" },
    checks: [{ name: "changed files detected", ok: true, blocking: true }],
    decision: "ready_to_merge",
  });
  assert.match(markdown, /Decision: \*\*ready_to_merge\*\*/);
  assert.match(markdown, /does not invoke an API-credit reviewer agent/);
});

function mockReviewDiff(task, overrides = {}) {
  return {
    runId: "phase-6",
    targetId: task.id,
    targetType: "task",
    repoRoot: path.dirname(task.worktree),
    baseRef: "HEAD",
    branch: task.branch,
    worktree: task.worktree,
    head: "mock-head",
    branchExists: true,
    worktreeExists: true,
    changedFiles: [{ path: "note.txt", status: "M", sources: ["worktree"] }],
    unmergedFiles: [],
    errors: [],
    summary: "Mock diff summary",
    ...overrides,
  };
}

test("review config defaults to deterministic no-credit mode and normalizes opt-in AI settings", () => {
  const defaults = multitask.aiReview.normalizeReviewConfig();
  assert.equal(defaults.mode, "deterministic");
  assert.equal(defaults.reviewerAgent, "reviewer");
  assert.equal(defaults.maxRounds, 2);
  assert.equal(defaults.requireDeterministicPass, true);
  assert.equal(defaults.aiEnabled, false);
  assert.equal(defaults.noCredit, true);

  const optIn = multitask.aiReview.normalizeReviewConfig({ review: { mode: "both", reviewerAgent: "strict-reviewer", maxRounds: 3, requireDeterministicPass: false } });
  assert.equal(optIn.mode, "both");
  assert.equal(optIn.reviewerAgent, "strict-reviewer");
  assert.equal(optIn.maxRounds, 3);
  assert.equal(optIn.requireDeterministicPass, false);
  assert.equal(optIn.aiEnabled, true);
  assert.equal(optIn.creditConsuming, true);
});

test("deterministic-only review remains no-credit and marks clean tasks ready_to_merge", async () => withTempRepo(async (repoRoot) => {
  const manifest = fixtureManifest(repoRoot, { status: "ready_for_review" });
  const task = manifest.tasks[0];
  task.status = multitask.contracts.TASK_STATUS.READY_FOR_REVIEW;
  await multitask.manifest.initializeRunState(repoRoot, manifest, { planMarkdown: "# plan\n" });
  await fs.mkdir(task.worktree, { recursive: true });
  await fs.writeFile(path.join(task.worktree, "note.txt"), "implemented\n", "utf8");

  let aiRunnerCalled = false;
  const result = await multitask.review.reviewTasks({ runId: manifest.runId, mode: "deterministic" }, {
    repo: { root: repoRoot },
    manifest,
    getTaskDiff: async (_repoRoot, _manifest, reviewTask) => mockReviewDiff(reviewTask),
    branchExists: async () => true,
    runReviewer: async () => {
      aiRunnerCalled = true;
      throw new Error("AI runner should not be called in deterministic mode");
    },
  });

  assert.equal(aiRunnerCalled, false);
  assert.equal(result.noCredit, true);
  assert.equal(result.creditConsuming, false);
  assert.equal(result.reviews[0].decision, "ready_to_merge");
  assert.equal(result.reviews[0].aiReview.status, "disabled");
  assert.equal(result.reviews[0].aiReview.creditConsuming, false);
  assert.match(result.summary, /no-credit deterministic/);

  const savedTask = await multitask.manifest.loadTaskState(repoRoot, manifest.runId, task.id);
  assert.equal(savedTask.status, "ready_to_merge");
  assert.equal(savedTask.review.noCredit, true);
  assert.equal(savedTask.review.ai.status, "disabled");
  assert.match(await fs.readFile(savedTask.reviewPath, "utf8"), /AI review disabled\. No AI credits consumed\./);
}));

test("AI-review-disabled path stays no-credit even when a mock reviewer is available", async () => withTempRepo(async (repoRoot) => {
  const manifest = fixtureManifest(repoRoot, {
    status: "ready_for_review",
    reviewConfig: { mode: "deterministic", reviewerAgent: "reviewer", maxRounds: 2 },
  });
  const task = manifest.tasks[0];
  task.status = multitask.contracts.TASK_STATUS.READY_FOR_REVIEW;
  await multitask.manifest.initializeRunState(repoRoot, manifest, { planMarkdown: "# plan\n" });
  await fs.mkdir(task.worktree, { recursive: true });
  await fs.writeFile(path.join(task.worktree, "note.txt"), "implemented\n", "utf8");

  let calls = 0;
  const result = await multitask.review.reviewTasks({ runId: manifest.runId }, {
    repo: { root: repoRoot },
    manifest,
    getTaskDiff: async (_repoRoot, _manifest, reviewTask) => mockReviewDiff(reviewTask),
    branchExists: async () => true,
    runReviewer: async () => {
      calls += 1;
      return { decision: "needs_changes", findings: ["Should not run"] };
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.noCredit, true);
  assert.equal(result.reviews[0].reviewConfig.mode, "deterministic");
  assert.equal(result.reviews[0].aiReview.enabled, false);
}));

test("mock AI review actionable findings become needs_changes with review_feedback for workers", async () => withTempRepo(async (repoRoot, tempRoot) => {
  const manifest = fixtureManifest(repoRoot, { status: "ready_for_review" });
  const task = manifest.tasks[0];
  task.status = multitask.contracts.TASK_STATUS.READY_FOR_REVIEW;
  await multitask.manifest.initializeRunState(repoRoot, manifest, { planMarkdown: "# plan\n" });
  await fs.mkdir(task.worktree, { recursive: true });
  await fs.writeFile(path.join(task.worktree, "note.txt"), "implemented\n", "utf8");

  const reviewerCalls = [];
  const result = await multitask.review.reviewTasks({ runId: manifest.runId, mode: "ai", reviewerAgent: "reviewer" }, {
    repo: { root: repoRoot },
    manifest,
    getTaskDiff: async (_repoRoot, _manifest, reviewTask) => mockReviewDiff(reviewTask),
    branchExists: async () => true,
    agentOptions: {
      homeDir: path.join(tempRoot, "empty-home"),
      includeProjectAgents: false,
      includeLegacyProjectAgents: false,
    },
    runReviewer: async (input) => {
      reviewerCalls.push(input);
      return {
        decision: "needs_changes",
        summary: "Add validation coverage before merge.",
        findings: [{ severity: "major", path: "note.txt", line: 1, message: "No validation evidence is included.", suggestion: "Run and report the focused tests." }],
      };
    },
  });

  assert.equal(reviewerCalls.length, 1);
  assert.equal(reviewerCalls[0].creditConsuming, true);
  assert.equal(reviewerCalls[0].agentResolution.config.name, "reviewer");
  assert.match(reviewerCalls[0].prompt, /AI review is opt-in and may consume Pi\/API credits/);
  assert.equal(result.creditConsuming, true);
  assert.equal(result.noCredit, false);
  assert.equal(result.reviews[0].decision, "needs_changes");
  assert.equal(result.reviews[0].aiReview.status, "completed");
  assert.equal(result.reviews[0].aiReview.creditConsuming, true);
  assert.equal(result.reviews[0].aiReview.actionableFindings.length, 1);
  assert.equal(result.reviews[0].feedback.dto.type, "review_feedback");
  assert.match(result.reviews[0].feedback.prompt, /Please address the feedback/);
  assert.match(result.summary, /AI review credit-consuming/);

  const savedTask = await multitask.manifest.loadTaskState(repoRoot, manifest.runId, task.id);
  assert.equal(savedTask.status, "needs_changes");
  assert.equal(savedTask.review.ai.hasActionableFindings, true);
  assert.equal(savedTask.review.feedback.dto.type, "review_feedback");
  const statusDto = multitask.contracts.createTaskStatusDto(savedTask, { runId: manifest.runId });
  assert.equal(statusDto.review.ai.creditConsuming, true);
  assert.equal(statusDto.review.ai.actionableFindings.length, 1);
}));

test("mock AI review approval reaches ready_to_merge only after deterministic checks pass", async () => withTempRepo(async (repoRoot, tempRoot) => {
  const manifest = fixtureManifest(repoRoot, { status: "ready_for_review" });
  const task = manifest.tasks[0];
  task.status = multitask.contracts.TASK_STATUS.READY_FOR_REVIEW;
  await multitask.manifest.initializeRunState(repoRoot, manifest, { planMarkdown: "# plan\n" });
  await fs.mkdir(task.worktree, { recursive: true });
  await fs.writeFile(path.join(task.worktree, "note.txt"), "implemented\n", "utf8");

  const result = await multitask.review.reviewTasks({ runId: manifest.runId, mode: "both" }, {
    repo: { root: repoRoot },
    manifest,
    getTaskDiff: async (_repoRoot, _manifest, reviewTask) => mockReviewDiff(reviewTask),
    branchExists: async () => true,
    agentOptions: { homeDir: path.join(tempRoot, "empty-home"), includeProjectAgents: false, includeLegacyProjectAgents: false },
    runReviewer: async () => ({ decision: "ready_to_merge", summary: "No actionable findings.", findings: [] }),
  });

  assert.equal(result.reviews[0].deterministic.passed, true);
  assert.equal(result.reviews[0].aiReview.hasActionableFindings, false);
  assert.equal(result.reviews[0].decision, "ready_to_merge");
  const savedTask = await multitask.manifest.loadTaskState(repoRoot, manifest.runId, task.id);
  assert.equal(savedTask.status, "ready_to_merge");
}));

test("deterministic failures block ready_to_merge and skip AI when deterministic pass is required", async () => withTempRepo(async (repoRoot, tempRoot) => {
  const manifest = fixtureManifest(repoRoot, { status: "ready_for_review" });
  const task = manifest.tasks[0];
  task.status = multitask.contracts.TASK_STATUS.READY_FOR_REVIEW;
  await multitask.manifest.initializeRunState(repoRoot, manifest, { planMarkdown: "# plan\n" });
  await fs.mkdir(task.worktree, { recursive: true });

  let reviewerCalled = false;
  const result = await multitask.review.reviewTasks({ runId: manifest.runId, mode: "ai", requireDeterministicPass: true }, {
    repo: { root: repoRoot },
    manifest,
    getTaskDiff: async (_repoRoot, _manifest, reviewTask) => mockReviewDiff(reviewTask, { changedFiles: [], summary: "No diff" }),
    branchExists: async () => true,
    agentOptions: { homeDir: path.join(tempRoot, "empty-home"), includeProjectAgents: false, includeLegacyProjectAgents: false },
    runReviewer: async () => {
      reviewerCalled = true;
      return { decision: "ready_to_merge" };
    },
  });

  assert.equal(reviewerCalled, false);
  assert.equal(result.reviews[0].decision, "needs_changes");
  assert.equal(result.reviews[0].deterministic.passed, false);
  assert.equal(result.reviews[0].aiReview.status, "skipped");
  assert.equal(result.reviews[0].aiReview.reason, "deterministic_failed");
  assert.equal(result.reviews[0].feedback.dto.type, "review_feedback");
  assert.match(result.reviews[0].feedback.prompt, /Deterministic review found blocking issues/);
  const savedTask = await multitask.manifest.loadTaskState(repoRoot, manifest.runId, task.id);
  assert.equal(savedTask.status, "needs_changes");
  assert.equal(savedTask.review.feedback.dto.payload.creditConsuming, false);
}));

async function writeAgent(file, markdown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, markdown.trimStart() + "\n", "utf8");
}

test("agent registry resolves bundled reviewer definitions into launch metadata", async () => withTempRepo(async (repoRoot, tempRoot) => {
  const packageRoot = path.join(tempRoot, "pkg");
  const homeDir = path.join(tempRoot, "home");
  await writeAgent(path.join(packageRoot, "agents", "reviewer.md"), `
---
name: reviewer
description: Review worker changes
model: test/reviewer
thinking: high
tools: read,bash,grep
skills: review, risk
systemPromptMode: append
inheritProjectContext: true
maxTurns: 12
---

Review the task diff and report merge readiness.
`);

  const resolution = await multitask.agents.resolveAgent("reviewer", { packageRoot, homeDir, repoRoot });
  assert.equal(resolution.agent.source, "bundled");
  assert.equal(resolution.config.name, "reviewer");
  assert.deepEqual(resolution.config.tools, ["read", "bash", "grep"]);
  assert.deepEqual(resolution.config.skills, ["review", "risk"]);
  assert.equal(resolution.config.maxTurns, 12);

  const metadata = multitask.agents.agentConfigToWorkerLaunchMetadata(resolution, {
    manifest: { runId: "phase-6" },
    task: { id: "api", branch: "mt/phase-6/api", worktree: "/tmp/api" },
  });
  assert.equal(metadata.launchOptions.agent, "reviewer");
  assert.equal(metadata.launchOptions.model, "test/reviewer");
  assert.match(metadata.promptAddition, /Porchestrator Agent Role: reviewer/);
  assert.match(metadata.promptAddition, /Review the task diff/);
  assert.match(metadata.promptAddition, /Run: phase-6/);
}));

test("bundled task.agent reviewer resolves from package defaults", async () => withTempRepo(async (repoRoot, tempRoot) => {
  const resolution = await multitask.agents.resolveAgentForTask(
    { id: "review", agent: "reviewer", branch: "mt/r/review", worktree: "/tmp/review" },
    { repoRoot, homeDir: path.join(tempRoot, "empty-home"), manifest: { runId: "r" } },
  );
  assert.equal(resolution.agent.source, "bundled");
  assert.equal(resolution.config.name, "reviewer");
  assert.match(resolution.workerLaunchMetadata.promptAddition, /orchestrated worker branch/);
}));

test("agent registry applies bundled, user, and trusted project precedence", async () => withTempRepo(async (repoRoot, tempRoot) => {
  const packageRoot = path.join(tempRoot, "pkg");
  const homeDir = path.join(tempRoot, "home");
  await writeAgent(path.join(packageRoot, "agents", "worker.md"), `
---
name: worker
description: Bundled worker
model: bundled/model
tools: read
---
Bundled prompt.
`);
  await writeAgent(path.join(homeDir, ".pi", "agent", "agents", "worker.md"), `
---
name: worker
description: User worker
model: user/model
tools: read,bash
---
User prompt.
`);
  await writeAgent(path.join(repoRoot, ".pi", "agents", "worker.md"), `
---
name: worker
description: Project worker
model: project/model
tools: read,bash,edit,write
---
Project prompt.
`);

  const userResolution = await multitask.agents.resolveAgent("worker", {
    packageRoot,
    homeDir,
    repoRoot,
    includeProjectAgents: false,
    includeLegacyProjectAgents: false,
  });
  assert.equal(userResolution.agent.source, "user");
  assert.equal(userResolution.config.model, "user/model");

  const projectResolution = await multitask.agents.resolveAgent("worker", {
    packageRoot,
    homeDir,
    repoRoot,
    allowProjectAgents: true,
  });
  assert.equal(projectResolution.agent.source, "project");
  assert.equal(projectResolution.config.description, "Project worker");
  assert.equal(projectResolution.config.model, "user/model");
  assert.deepEqual(projectResolution.config.tools, ["read", "bash"]);
  assert.deepEqual(projectResolution.security.sensitiveRuntimeFieldsIgnored.sort(), ["model", "tools"]);

  const explicitRuntime = await multitask.agents.resolveAgent("worker", {
    packageRoot,
    homeDir,
    repoRoot,
    allowProjectAgents: true,
    allowProjectRuntimeControls: true,
  });
  assert.equal(explicitRuntime.config.model, "project/model");
  assert.deepEqual(explicitRuntime.config.tools, ["read", "bash", "edit", "write"]);
}));

test("project-local agents require confirmation or explicit opt-in", async () => withTempRepo(async (repoRoot, tempRoot) => {
  const packageRoot = path.join(tempRoot, "pkg");
  const homeDir = path.join(tempRoot, "home");
  await writeAgent(path.join(packageRoot, "agents", "reviewer.md"), `
---
name: reviewer
description: Bundled reviewer
---
Bundled reviewer.
`);
  await writeAgent(path.join(repoRoot, ".pi", "agents", "reviewer.md"), `
---
name: reviewer
description: Project reviewer
---
Project reviewer.
`);

  await assert.rejects(
    multitask.agents.resolveAgent("reviewer", { packageRoot, homeDir, repoRoot }),
    (error) => error.code === "PI_MULTITASK_PROJECT_AGENT_UNTRUSTED" && /not trusted/.test(error.message),
  );

  let confirmedAgent;
  const confirmed = await multitask.agents.resolveAgent("reviewer", {
    packageRoot,
    homeDir,
    repoRoot,
    interactive: true,
    confirmProjectAgent: async (agent) => {
      confirmedAgent = agent;
      return true;
    },
  });
  assert.equal(confirmedAgent.name, "reviewer");
  assert.equal(confirmed.agent.source, "project");
  assert.equal(confirmed.trust.reason, "interactive_confirmation");

  const fallback = await multitask.agents.resolveAgent("reviewer", {
    packageRoot,
    homeDir,
    repoRoot,
    onUntrustedProjectAgent: "fallback",
  });
  assert.equal(fallback.agent.source, "bundled");
  assert.match(fallback.warnings.join("\n"), /Skipped untrusted project-local agent/);
}));

test("legacy .agents definitions are discoverable with the same project trust boundary", async () => withTempRepo(async (repoRoot, tempRoot) => {
  const packageRoot = path.join(tempRoot, "pkg");
  const homeDir = path.join(tempRoot, "home");
  await writeAgent(path.join(repoRoot, ".agents", "scout.md"), `
---
name: scout
description: Legacy project scout
tools:
  - read
  - grep
---
Scout from legacy project agents.
`);

  await assert.rejects(
    multitask.agents.resolveAgent("scout", { packageRoot, homeDir, repoRoot, includeBundledAgents: false, includeUserAgents: false }),
    /Project-local multitask agent "scout"/,
  );

  const resolution = await multitask.agents.resolveAgent("scout", {
    packageRoot,
    homeDir,
    repoRoot,
    includeBundledAgents: false,
    includeUserAgents: false,
    allowProjectAgents: true,
  });
  assert.equal(resolution.agent.source, "legacy-project");
  assert.deepEqual(resolution.agent.tools, ["read", "grep"]);
  assert.deepEqual(resolution.config.tools, undefined);
  assert.deepEqual(resolution.security.sensitiveRuntimeFieldsIgnored, ["tools"]);
}));
