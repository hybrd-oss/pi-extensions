# Pi Multitask Mode Redesign

## Goal

Rebuild the current pi orchestrator extension as a Cursor-like multitask mode:

- The user keeps talking to one main Pi agent.
- The main agent can spawn multiple local worker agents.
- Workers run in isolated local git worktrees.
- Workers continue running in the background while the main chat remains usable.
- The user/main agent can monitor, message, steer, cancel, review, and merge workers.

This is a breaking-change redesign. The old batch-oriented orchestrator model can be replaced.

## Product Model

The extension should become a local background-agent manager:

```text
main Pi chat
  ├─ spawn multitask run
  ├─ spawn/add workers
  ├─ send follow-up messages to workers
  ├─ inspect status and diffs
  ├─ review worker output
  ├─ merge/apply selected results
  └─ keep chatting while workers run
```

Local worktrees only. No remote/cloud agents.

## Current Gap

The current orchestrator has good foundations:

- per-task worktrees
- branches
- manifests
- startup and validation scripts
- integration worktree
- merge/verify/cleanup flows

But it is batch-oriented:

```text
main agent -> orchestrator_dispatch -> waits for all workers -> returns
```

Workers are currently one-shot subprocesses using `pi --mode json -p --no-session`, with stdin ignored. That prevents true Cursor-style follow-up messaging.

## Target Architecture

Move from one-shot workers to persistent worker sessions.

Pi already supports the needed primitives through SDK/RPC:

- `prompt`
- `steer`
- `follow_up`
- `abort`
- `get_state`
- `get_messages`

Workers should run as local Pi RPC sessions:

```bash
pi --mode rpc \
  --session-dir .pi/multitask/runs/<run-id>/tasks/<task-id>/session \
  --append-system-prompt <worker-prompt.md> \
  --model <model> \
  --tools read,bash,edit,write,grep,find,ls
```

Use this environment guard:

```text
PI_MULTITASK_ROLE=worker
```

to prevent worker processes from spawning their own worker fleets unless explicitly allowed.

## Local Daemon / Run Manager

Use a small local daemon/process as the background manager. The extension talks to it from tools, commands, and TUI.

The daemon owns:

- worker process handles
- RPC stdin/stdout
- task queues
- concurrency limits
- manifest updates
- event logs
- validation script execution
- cancellation
- worker restart/resume
- diff summary generation

The Pi extension owns:

- tools
- slash commands
- TUI panel/widgets
- system prompt guidance
- config UI

This lets the main chat remain usable while workers run.

## State Layout

Recommended state directory:

```text
.pi/multitask/
  config.json
  daemon.sock
  daemon.pid
  runs/
    <run-id>/
      manifest.json
      plan.md
      events.jsonl
      tasks/
        <task-id>/
          state.json
          events.jsonl
          transcript.jsonl
          stdout.log
          stderr.log
          review.md
          session/
```

Recommended worktree layout:

```text
../<repo>-multitask-worktrees/
  <run-id>/
    api/
    ui/
    tests/
    integration/
```

Recommended branch names:

```text
mt/<run-id>/<task-id>
mt/<run-id>/integration
```

## Task Lifecycle

Suggested task states:

```text
planned
queued
creating_worktree
setup
running
idle
needs_attention
validating
validation_failed
ready_for_review
reviewing
needs_changes
ready_to_merge
merged
failed
cancelled
```

A worker can be `idle` but still available for follow-up messages.

Example normal flow:

```text
planned
→ creating_worktree
→ setup
→ running
→ idle
→ validating
→ ready_for_review
→ reviewing
→ ready_to_merge
→ merged
```

Example follow-up flow:

```text
ready_for_review
→ running
→ idle
→ validating
→ ready_for_review
```

## Tool Surface

Replace the old `orchestrator_*` tools with `multitask_*` tools.

### `multitask_start`

Create a run, create local worktrees, start workers, and return immediately.

```ts
{
  runName?: string
  baseRef?: string
  maxConcurrency?: number
  tasks: Array<{
    id: string
    title?: string
    prompt: string
    agent?: string
    model?: string
    startupScripts?: string[]
    validationScripts?: string[]
  }>
  integration?: {
    startupScripts?: string[]
    validationScripts?: string[]
  }
}
```

### `multitask_spawn`

Add a worker to an existing run.

```ts
{
  runId: string
  id: string
  prompt: string
  baseRef?: string
  startupScripts?: string[]
  validationScripts?: string[]
}
```

### `multitask_message`

Send a message to a worker.

```ts
{
  runId: string
  taskId: string
  message: string
  mode?: "steer" | "followUp"
}
```

Behavior:

- if worker is running, use RPC `steer` or `follow_up`
- if worker is idle, use RPC `prompt`

This is the key Cursor-like primitive.

### `multitask_status`

Show runs/tasks.

```ts
{
  runId?: string
}
```

### `multitask_diff`

Show changed files and diff summary.

```ts
{
  runId: string
  taskId?: string
  integration?: boolean
}
```

### `multitask_review`

Run review for one task or all reviewable tasks.

```ts
{
  runId: string
  taskId?: string
}
```

### `multitask_merge`

Merge selected ready tasks into the integration worktree.

```ts
{
  runId: string
  taskIds?: string[]
}
```

### `multitask_apply`

Apply/merge the integration branch back to the foreground checkout.

```ts
{
  runId: string
  requireClean?: boolean
}
```

Should require confirmation when interactive UI is available.

### `multitask_cancel`

Cancel a worker or whole run.

```ts
{
  runId: string
  taskId?: string
}
```

## Slash Commands

Primary entrypoints:

```text
/multitask <request>
/mt <request>
```

Management commands:

```text
/mt-status [run-id]
/mt-panel
/mt-send <run-id> <task-id>
/mt-diff <run-id> [task-id]
/mt-review <run-id> [task-id]
/mt-merge <run-id> [task-id...]
/mt-apply <run-id>
/mt-cancel <run-id> [task-id]
/mt-cleanup <run-id>
```

Commands should directly control the daemon when appropriate. They should not all route through the main model.

## TUI Surface

Support three ways to drive multitask mode:

1. Natural language through the main agent.
2. Slash commands.
3. TUI panel/widgets.

### Persistent Widget

Show compact status near the editor:

```text
Multitask: 1 run active
  login-refactor: api running · ui ready for review · tests queued
```

Footer/status example:

```text
mt: 3 workers
```

### `/mt-panel`

Open a task panel similar to Cursor's Agents Window:

```text
Pi Multitask

Run: login-refactor                         status: running

> api       running          mt/login-refactor/api
  ui        ready_review     5 files changed
  tests     queued

enter inspect · m message · d diff · r review · x cancel · q close
```

Task detail view:

```text
api
status: running
worktree: ../repo-multitask-worktrees/login-refactor/api
branch: mt/login-refactor/api

Last events:
- read src/auth/session.ts
- edited src/auth/token.ts
- running npm test

Actions:
[m] send message
[d] show diff
[r] review
[c] cancel
```

## System Prompt Guidance

Replace the old orchestrator prompt guidance with something like:

```text
# Pi Multitask

When the user asks to multitask, parallelize, use workers, delegate, use background agents, or mentions /multitask or /mt, use the multitask tools.

Preferred flow:
1. Inspect relevant files/specs.
2. Decompose into independent local-worktree tasks.
3. Tell the user the proposed workers and script selections.
4. After approval, call multitask_start.
5. Continue helping while workers run.
6. Use multitask_status, multitask_diff, and multitask_message to monitor and steer workers.
7. Review before merge.
8. Merge/apply only after user approval.

Workers are local Pi RPC sessions in git worktrees. Use multitask_message to send follow-ups.
```

## Preserve From Current Orchestrator

Keep:

- named scripts config
- startup scripts
- validation scripts
- git/worktree helpers
- integration worktree concept
- manifest persistence
- mock runner tests
- reviewer and merger prompts

Remove or heavily change:

- `worktreeMode`
- blocking `orchestrator_dispatch`
- one-shot `runWorker`
- `pi --mode json -p --no-session` workers
- old plan/dispatch batch lifecycle
- `/orch-*` as the primary UX

## Implementation Progress

Workers should update this section using `[todo]`, `[in progress]`, and `[complete]`.

- [complete] Phase 1: Core backend/state model
- [complete] Phase 2: Pi RPC worker sessions and daemon messaging
- [complete] Phase 3: Extension tools, commands, and system prompt
- [complete] Phase 4: TUI status widget/panel
- [complete] Phase 5: Review, merge, apply flows
- [complete] Phase 6: Robustness and tests

## Implementation Phases

### Phase 1: Core Backend

- Add `.pi/multitask` state model.
- Add daemon/client boundary.
- Add manifest/events model.
- Create local worktrees only.
- Start workers asynchronously.
- Return immediately from `multitask_start`.

### Phase 2: Pi RPC Workers

- Implement RPC client.
- Support `prompt`, `steer`, `follow_up`, `abort`, `get_state`.
- Persist transcripts/events.
- Update task status from RPC events.
- Keep worker process alive after idle for follow-ups.

### Phase 3: Tools and Commands

- Replace current tools with `multitask_*`.
- Add `/multitask`, `/mt`, and management commands.
- Update system prompt guidance.

### Phase 4: TUI

- Add compact status widget.
- Add `/mt-panel` overlay.
- Support inspect, message, diff, cancel, and review actions.

### Phase 5: Review and Merge

- Wire reviewer agent into `multitask_review`.
- Mark tasks `ready_to_merge` or `needs_changes`.
- Merge selected ready tasks into integration worktree.
- Add `multitask_apply`.

### Phase 6: Robustness

- daemon restart behavior
- stale pid detection
- idle worker TTL
- resume worker from saved session
- conflict-resolution worker
- richer diff summaries

## Recommended File Layout

```text
pi-orchestrator/
  extensions/
    multitask.ts
  src/
    multitask/
      client.js
      daemon.js
      daemon-protocol.js
      manifest.js
      events.js
      config.js
      git.js
      scripts.js
      rpc-worker-session.js
      diff.js
      review.js
      merge.js
      tui-state.js
```

Public names should be:

```text
Tools:    multitask_*
Commands: /multitask, /mt-*
State:    .pi/multitask
Branches: mt/<run>/<task>
```
