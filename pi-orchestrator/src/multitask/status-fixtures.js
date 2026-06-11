const {
  MESSAGE_DIRECTION,
  MESSAGE_MODE,
  MESSAGE_TYPE,
  RUN_STATUS,
  TASK_STATUS,
  WORKER_ATTACHMENT_STATE,
  createMessageDto,
  createStatusResponseDto,
} = require("./contracts.js");

const FIXTURE_NOW = "2026-05-28T12:00:00.000Z";
const FIXTURE_RUN_ID = "fixture-mixed-run";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fixtureTask(id, status, overrides = {}) {
  return {
    id,
    title: overrides.title || id,
    prompt: overrides.prompt || `Fixture task ${id}`,
    agent: overrides.agent || "worker",
    status,
    createdAt: "2026-05-28T11:00:00.000Z",
    updatedAt: FIXTURE_NOW,
    branch: `mt/${FIXTURE_RUN_ID}/${id}`,
    worktree: `/tmp/pi-multitask/${FIXTURE_RUN_ID}/${id}`,
    paths: {
      session: `/tmp/pi-multitask-state/${FIXTURE_RUN_ID}/tasks/${id}/session`,
    },
    worker: overrides.worker,
    diff: overrides.diff,
    review: overrides.review,
    messageCounts: overrides.messageCounts,
    lastMessageAt: overrides.lastMessageAt,
    dependencies: overrides.dependencies,
    blockedBy: overrides.blockedBy,
    error: overrides.error,
  };
}

function createMixedRunManifestFixture(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "pi-multitask-run",
    runId: FIXTURE_RUN_ID,
    runName: "Fixture Mixed Run",
    status: RUN_STATUS.RUNNING,
    createdAt: "2026-05-28T11:00:00.000Z",
    updatedAt: FIXTURE_NOW,
    baseRef: "HEAD",
    baseCommit: "0000000000000000000000000000000000000000",
    baseBranch: "main",
    repoRoot: "/tmp/pi-multitask/repo",
    stateDir: `/tmp/pi-multitask-state/${FIXTURE_RUN_ID}`,
    worktreeRoot: `/tmp/pi-multitask/${FIXTURE_RUN_ID}`,
    maxConcurrency: 2,
    tasks: [
      fixtureTask("api", TASK_STATUS.QUEUED, {
        title: "API implementation",
        worker: { attachmentState: WORKER_ATTACHMENT_STATE.DETACHED_IDLE },
        messageCounts: { assignment: 1 },
      }),
      fixtureTask("ui", TASK_STATUS.RUNNING, {
        title: "UI implementation",
        startedAt: "2026-05-28T11:05:00.000Z",
        worker: {
          attachmentState: WORKER_ATTACHMENT_STATE.ATTACHED,
          activityStatus: "running",
          processStatus: "running",
          pid: 42420,
          sessionDir: `/tmp/pi-multitask-state/${FIXTURE_RUN_ID}/tasks/ui/session`,
          lastStateAt: FIXTURE_NOW,
        },
        messageCounts: { assignment: 1, inform: 2 },
        lastMessageAt: "2026-05-28T11:45:00.000Z",
      }),
      fixtureTask("copy", TASK_STATUS.NEEDS_ATTENTION, {
        title: "Copy decision",
        worker: {
          attachmentState: WORKER_ATTACHMENT_STATE.ATTACHED,
          activityStatus: "needs_attention",
          processStatus: "running",
          pid: 42421,
        },
        messageCounts: { assignment: 1, question: 1, report_blocked: 1 },
        lastMessageAt: "2026-05-28T11:50:00.000Z",
        error: "Needs product decision before continuing.",
      }),
      fixtureTask("tests", TASK_STATUS.READY_FOR_REVIEW, {
        title: "Test coverage",
        completedAt: "2026-05-28T11:40:00.000Z",
        worker: {
          attachmentState: WORKER_ATTACHMENT_STATE.COMPLETED,
          activityStatus: "idle",
          processStatus: "exited",
        },
        diff: { changedFiles: ["test/api.test.js", "test/ui.test.js"], summary: "2 files changed" },
        messageCounts: { assignment: 1, report_done: 1 },
      }),
      fixtureTask("docs", TASK_STATUS.READY_TO_MERGE, {
        title: "Documentation",
        completedAt: "2026-05-28T11:30:00.000Z",
        worker: {
          attachmentState: WORKER_ATTACHMENT_STATE.COMPLETED,
          activityStatus: "idle",
          processStatus: "exited",
        },
        diff: { changedFiles: ["README.md"], summary: "1 file changed" },
        review: { decision: "ready_to_merge", checks: [{ name: "changed files detected", ok: true }] },
        messageCounts: { assignment: 1, review_feedback: 1, report_done: 1 },
      }),
    ],
    integration: {
      id: "integration",
      status: "idle",
      branch: `mt/${FIXTURE_RUN_ID}/integration`,
      worktree: `/tmp/pi-multitask/${FIXTURE_RUN_ID}/integration`,
    },
    ...overrides,
  };
}

function createMessageFixture(overrides = {}) {
  const runId = overrides.runId || FIXTURE_RUN_ID;
  const createdAt = overrides.createdAt || FIXTURE_NOW;
  const messages = [
    createMessageDto({
      id: "msg-assignment-api",
      runId,
      taskId: "api",
      type: MESSAGE_TYPE.ASSIGNMENT,
      direction: MESSAGE_DIRECTION.SUPERVISOR_TO_WORKER,
      mode: MESSAGE_MODE.PROMPT,
      text: "Implement the API contract.",
      createdAt,
    }),
    createMessageDto({
      id: "msg-question-copy",
      runId,
      taskId: "copy",
      type: MESSAGE_TYPE.QUESTION,
      direction: MESSAGE_DIRECTION.WORKER_TO_SUPERVISOR,
      mode: MESSAGE_MODE.FOLLOW_UP,
      correlationId: "decision-copy-tone",
      text: "Should the empty state be playful or formal?",
      createdAt,
    }),
    createMessageDto({
      id: "msg-decision-copy",
      runId,
      taskId: "copy",
      type: MESSAGE_TYPE.DECISION,
      direction: MESSAGE_DIRECTION.SUPERVISOR_TO_WORKER,
      mode: MESSAGE_MODE.FOLLOW_UP,
      correlationId: "decision-copy-tone",
      text: "Use concise formal copy.",
      createdAt,
    }),
    createMessageDto({
      id: "msg-review-feedback-docs",
      runId,
      taskId: "docs",
      type: MESSAGE_TYPE.REVIEW_FEEDBACK,
      direction: MESSAGE_DIRECTION.SUPERVISOR_TO_WORKER,
      mode: MESSAGE_MODE.FOLLOW_UP,
      text: "Review passed; ready to merge.",
      createdAt,
    }),
    createMessageDto({
      id: "msg-report-done-tests",
      runId,
      taskId: "tests",
      type: MESSAGE_TYPE.REPORT_DONE,
      direction: MESSAGE_DIRECTION.WORKER_TO_SUPERVISOR,
      mode: MESSAGE_MODE.FOLLOW_UP,
      text: "Tests are implemented and ready for review.",
      createdAt,
      payload: { changedFiles: ["test/api.test.js", "test/ui.test.js"] },
    }),
    createMessageDto({
      id: "msg-report-blocked-copy",
      runId,
      taskId: "copy",
      type: MESSAGE_TYPE.REPORT_BLOCKED,
      direction: MESSAGE_DIRECTION.WORKER_TO_SUPERVISOR,
      mode: MESSAGE_MODE.FOLLOW_UP,
      correlationId: "decision-copy-tone",
      text: "Blocked pending copy tone decision.",
      createdAt,
      payload: { reason: "need_decision" },
    }),
  ];
  return messages.map((message) => ({ ...message, ...overrides.messageOverrides }));
}

function createMixedRunStatusFixture(options = {}) {
  const manifest = options.manifest || createMixedRunManifestFixture();
  return createStatusResponseDto({
    runs: [manifest],
    activeRunId: manifest.runId,
    daemonStatus: {
      status: "running",
      pid: 4242,
      socketReachable: true,
      socketPath: "/tmp/pi-multitask/daemon.sock",
    },
    summary: "Fixture Mixed Run: running (1 queued · 1 running · 1 attention · 2 ready)",
  }, { generatedAt: options.generatedAt || FIXTURE_NOW, activeRunId: manifest.runId });
}

const mixedRunManifest = Object.freeze(createMixedRunManifestFixture());
const mixedRunStatus = Object.freeze(createMixedRunStatusFixture({ manifest: clone(mixedRunManifest) }));
const messageFixtures = Object.freeze(createMessageFixture());

module.exports = {
  FIXTURE_NOW,
  FIXTURE_RUN_ID,
  createMessageFixture,
  createMixedRunManifestFixture,
  createMixedRunStatusFixture,
  messageFixtures,
  mixedRunManifest,
  mixedRunStatus,
};
