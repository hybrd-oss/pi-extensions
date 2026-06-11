# Pi Multitask Contracts (Segment 0)

This document records the shared names and DTO shapes used by the multitask daemon, client, TUI widget/panel, and tests. The importable source of truth is `pi-orchestrator/src/multitask/contracts.js`.

## Canonical task statuses

Task statuses are intentionally small and shared across later modules:

```text
planned
creating_worktree
setup
queued
blocked
running
idle
needs_attention
ready_for_review
needs_changes
ready_to_merge
merged
failed
aborted
```

UI code may group these into board categories:

- `queued`: `planned`, `creating_worktree`, `setup`, `queued`
- `running`: `running`
- `attention`: `blocked`, `needs_attention`, `needs_changes`
- `ready`: `ready_for_review`, `ready_to_merge`
- `terminal`: `merged`, `failed`, `aborted`

## Worker attachment states

```text
attached
detached_idle
lost_running
completed
```

These describe the relationship between a persisted task and the current daemon process, not the business status of the task.

## Message types

```text
assignment
question
inform
review_feedback
decision
report_done
report_blocked
```

The Segment 0 contract only defines the envelope and constants. Transport-specific formatting and parsing belongs to the later typed-message segment.

## Status DTOs

### Task status DTO

```js
{
  kind: "pi-multitask-task-status",
  schemaVersion: 1,
  runId: "login-refactor",
  taskId: "api",
  id: "api",                    // compatibility alias for manifest/TUI code
  status: "running",
  statusCategory: "running",
  title: "API changes",
  agent: "worker",
  model: "provider/model",
  branch: "mt/login-refactor/api",
  worktree: "/path/to/worktree",
  createdAt: "2026-05-28T12:00:00.000Z",
  updatedAt: "2026-05-28T12:05:00.000Z",
  startedAt: "2026-05-28T12:01:00.000Z",
  completedAt: undefined,
  worker: {
    attachmentState: "attached",
    activityStatus: "running",
    processStatus: "running",
    pid: 12345,
    sessionDir: "/path/to/session"
  },
  diff: undefined,
  review: undefined,
  messageCounts: { assignment: 1, inform: 2 },
  lastMessageAt: "2026-05-28T12:04:00.000Z",
  dependencies: [],
  blockedBy: [],
  error: undefined
}
```

### Run status DTO

```js
{
  kind: "pi-multitask-run-status",
  schemaVersion: 1,
  runId: "login-refactor",
  id: "login-refactor",
  runName: "Login refactor",
  displayName: "Login refactor",
  status: "running",
  maxConcurrency: 2,
  tasks: [/* task status DTOs */],
  taskCounts: { queued: 1, running: 1, needs_attention: 1, ready_for_review: 1 },
  boardCounts: { queued: 1, running: 1, attention: 1, ready: 1 },
  queuedTaskCount: 1,
  runningTaskCount: 1,
  attentionTaskCount: 1,
  readyTaskCount: 1,
  activeTaskCount: 4,
  integration: { status: "idle" }
}
```

### Status response DTO

```js
{
  kind: "pi-multitask-status",
  schemaVersion: 1,
  generatedAt: "2026-05-28T12:00:00.000Z",
  activeRunId: "login-refactor",
  runs: [/* run status DTOs */],
  daemonStatus: { status: "running", pid: 12345 },
  totals: {
    runs: 1,
    tasks: 4,
    queuedTasks: 1,
    runningTasks: 1,
    attentionTasks: 1,
    readyTasks: 1
  },
  summary: "optional human summary"
}
```

## Message DTO

```js
{
  kind: "pi-multitask-message",
  schemaVersion: 1,
  id: "optional-id",
  runId: "login-refactor",
  taskId: "api",
  type: "decision",
  direction: "supervisor_to_worker",
  mode: "followUp",
  correlationId: "optional-correlation-id",
  from: "supervisor",
  to: "api",
  text: "Use option B.",
  createdAt: "2026-05-28T12:00:00.000Z",
  payload: {}
}
```

## Fixtures

`pi-orchestrator/src/multitask/status-fixtures.js` exports a mixed run fixture with queued, running, attention, and ready tasks plus representative typed messages. Use this fixture for no-credit contract tests and TUI/status rendering work.
