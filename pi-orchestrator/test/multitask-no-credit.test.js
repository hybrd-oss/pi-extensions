const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const { Writable } = require("node:stream");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const multitask = require("../src/multitask/index.js");

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

test("tui state formats active runs, panels, and daemon status text", () => {
  const state = multitask.tuiState.createTuiState({ runs: [{ runId: "r1", status: "running", tasks: [{ id: "api", status: "ready_for_review", diff: { changedFiles: ["a"] } }] }] }, { now: "now" });
  assert.equal(state.totals.activeRuns, 1);
  assert.match(multitask.tuiState.formatCompactWidgetLines(state).join("\n"), /Multitask: 1 run active/);
  assert.match(multitask.tuiState.formatPanelLines(state).join("\n"), /api\s+ready for review/);
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
