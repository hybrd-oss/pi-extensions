# Pi Multitask Competitor Lift Plan

## Worker Implementation Split

Implement this plan as a sequence of discrete worker tasks. Each numbered segment below should be assigned to exactly one worker in isolation. The parent/main agent should wait for that worker to finish, review the result, run the relevant tests, commit or otherwise stabilize the changes, and then spawn the next worker for the next segment.

This plan is intentionally **not** an MVP cut. Implement the entire plan. The sequencing exists to reduce conflicts and keep each worker focused. Most segments should add or modify a small number of modules and include no-credit tests. Avoid assigning multiple workers to high-conflict integration files at the same time, especially:

- `pi-orchestrator/src/multitask/daemon.js`
- `pi-orchestrator/src/multitask/client.js`
- `pi-orchestrator/extensions/orchestrator.ts`
- `pi-orchestrator/src/multitask/manifest.js`

Recommended operating loop for the parent agent:

1. Spawn one worker for the next segment only.
2. Give the worker the segment description, target files, acceptance criteria, and testing expectations.
3. Let the worker implement in isolation.
4. Review the worker's diff and transcript.
5. Run the segment's tests plus relevant smoke/no-credit tests.
6. Resolve integration issues in the parent context if small, or send the worker follow-up feedback.
7. Once stable, continue to the next segment.

### Segment 0 — Contracts and status model

Purpose: establish shared task/run/message state names and status DTO shapes so later workers do not invent incompatible representations.

Owns:

- `pi-orchestrator/src/multitask/contracts.js` or equivalent shared constants/schema module.
- Optional `specs/pi-multitask-contracts.md`.
- Status/task/message fixture data for tests and TUI work.

Define:

- Task statuses: `planned`, `creating_worktree`, `setup`, `queued`, `blocked`, `running`, `idle`, `needs_attention`, `ready_for_review`, `needs_changes`, `ready_to_merge`, `merged`, `failed`, `aborted`.
- Worker attachment states: `attached`, `detached_idle`, `lost_running`, `completed`.
- Message types: `assignment`, `question`, `inform`, `review_feedback`, `decision`, `report_done`, `report_blocked`.
- Run/task status DTOs consumed by daemon, client, widget, panel, and tests.

Acceptance:

- Shared constants or schemas are importable by later modules.
- Fixtures describe runs with queued/running/attention/ready tasks.
- No daemon behavior change is required in this segment.

### Segment 1 — Scheduler core

Purpose: implement the scheduling logic that enforces `maxConcurrency`, queueing, worker starts, blocked tasks, and dependency readiness.

Owns:

- `pi-orchestrator/src/multitask/scheduler.js`.
- Scheduler unit tests.

Avoid touching in this segment unless absolutely necessary:

- `pi-orchestrator/src/multitask/daemon.js`.
- `pi-orchestrator/extensions/orchestrator.ts`.

Responsibilities:

- Track queued/running/blocked tasks.
- Enforce `maxConcurrency`.
- Select tasks to start.
- Handle task completion/idling and select the next queued task.
- Emit planned state updates/events through an injectable interface or pure return value.
- Leave live daemon integration to Segment 10.

Acceptance:

- With `maxConcurrency: 2` and 5 queued tasks, only 2 are selected to start.
- When one task completes or idles, the next queued task becomes startable.
- Blocked/dependent tasks do not start until prerequisites are satisfied.
- No-credit scheduler tests pass.

### Segment 2 — Spawn/task provisioning

Purpose: implement the reusable task creation/provisioning path needed by `multitask_spawn`, without requiring final daemon wiring yet.

Owns:

- `pi-orchestrator/src/multitask/spawn.js`, `task-provisioning.js`, or equivalent.
- Targeted helper additions to `pi-orchestrator/src/multitask/manifest.js` if needed.
- Spawn/provisioning tests.

Responsibilities:

- Normalize task input.
- Validate task id uniqueness.
- Resolve startup and validation scripts.
- Create task records.
- Create task directories and session directories.
- Create or prepare worker worktrees/branches.
- Persist task state and manifest changes.
- Emit initial task events.
- Return compact task/run status for daemon/client use.

Acceptance:

- Given an existing run manifest, a new task can be appended.
- Spawned tasks get branch/worktree/session metadata.
- Spawned tasks start in `queued` or `creating_worktree`, depending on implementation details.
- Tests use mock workers and do not require real Pi credits.

### Segment 3 — Worker recovery/restart model

Purpose: make daemon restarts and lost in-memory worker handles detectable and recoverable.

Owns:

- `pi-orchestrator/src/multitask/recovery.js`.
- Targeted changes to `pi-orchestrator/src/multitask/rpc-worker-session.js` if needed.
- Recovery tests.

Responsibilities:

- Classify worker attachment state as `attached`, `detached_idle`, `lost_running`, or `completed`.
- Detect tasks whose manifest says `running` but whose process/session handle is missing.
- Provide restart/resume policy helpers.
- Support restart from persisted session directories where feasible.
- Produce actionable recovery suggestions for status and doctor output.

Acceptance:

- After daemon restart, stale running tasks can be detected.
- Detached idle workers can be identified from persisted session state.
- `restartIfNeeded` behavior can be exercised with mock sessions.
- Tests do not require live Pi workers.

### Segment 4 — Agent registry and role prompts

Purpose: make `task.agent` meaningful by loading bundled, user, and approved project-local role definitions.

Owns:

- `pi-orchestrator/src/multitask/agents.js`.
- Bundled agent files such as:
  - `pi-orchestrator/agents/worker.md`
  - `pi-orchestrator/agents/reviewer.md`
  - `pi-orchestrator/agents/scout.md`
  - `pi-orchestrator/agents/merger.md`
- Agent discovery/trust tests.

Responsibilities:

- Discover bundled agents, user agents, project agents, and optional legacy `.agents` definitions.
- Parse supported frontmatter: `name`, `description`, `model`, `thinking`, `tools`, `skills`, `systemPromptMode`, `inheritProjectContext`, `maxTurns`.
- Enforce trust rules for project-local agents.
- Map agent config into worker launch metadata and prompt additions.

Acceptance:

- `task.agent: "reviewer"` resolves to a concrete reviewer config.
- Bundled/user/project precedence is tested.
- Project-local agents require confirmation in interactive mode and are blocked or require explicit opt-in in non-interactive mode.
- Project-local definitions cannot silently escalate sensitive runtime controls.

### Segment 5 — Typed messages and attention model

Purpose: normalize supervisor/worker communication independently of transport and UI.

Owns:

- `pi-orchestrator/src/multitask/messages.js`.
- Message/report parser tests.

Responsibilities:

- Preserve simple string messages.
- Add typed message envelopes with `mode`, `type`, and optional `correlationId`.
- Normalize worker reports into status/reason/summary/changed-files/validation objects.
- Convert worker decision requests into `needs_attention` transitions.
- Convert review feedback and decisions into clear follow-up prompts.

Acceptance:

- Simple `multitask_message` string payloads still work after integration.
- Typed `decision` and `review_feedback` messages format correctly.
- Worker `need_decision`/`report_blocked` reports can be parsed and mapped to attention states.
- Tests do not require live Pi workers.

### Segment 6 — Review loop

Purpose: add optional AI review while preserving deterministic review as the mandatory no-credit baseline.

Owns:

- `pi-orchestrator/src/multitask/review.js`.
- Optional `pi-orchestrator/src/multitask/ai-review.js`.
- `pi-orchestrator/prompts/review-loop.md` if useful.
- Review tests.

Responsibilities:

- Add review config for `mode`, `reviewerAgent`, `maxRounds`, and `requireDeterministicPass`.
- Keep deterministic checks mandatory and no-credit.
- Add opt-in AI reviewer flow using the agent registry.
- Convert actionable AI findings into `needs_changes`.
- Support review feedback loops back to workers.
- Clearly report when AI review is credit-consuming.

Acceptance:

- Deterministic-only tests still pass.
- AI review disabled path remains fully no-credit.
- AI review output can be consumed by status/TUI/client code.
- Tasks become `ready_to_merge` only after required checks pass.

### Segment 7 — Workflow graph and dependencies

Purpose: add structured dependency and workflow input without turning the extension into a generic workflow framework.

Owns:

- `pi-orchestrator/src/multitask/workflow.js`.
- Workflow parser/validator tests.
- Targeted scheduler dependency tests.

Responsibilities:

- Support `dependencies?: Array<{ before: string, after: string }>` on `multitask_start` input.
- Reject cycles and unknown task ids.
- Support wave scheduling semantics through scheduler integration.
- Add small workflow graph parsing for `spawn`, `sequence`, `parallel`, `join`, and `loop` where practical.
- Persist flow tree/debug information.
- Add Mermaid export if it fits this segment cleanly; otherwise leave a documented hook for the export segment.

Acceptance:

- Independent tasks can run concurrently.
- Dependent tasks remain blocked until prerequisites reach the configured readiness policy.
- Invalid graphs fail with actionable errors.
- Workflow/dependency tests are no-credit.

### Segment 8 — TUI and observability polish

Purpose: upgrade status widget and `/mt-panel` against stable status DTOs.

Owns:

- `pi-orchestrator/src/multitask/tui-state.js`.
- Targeted panel/widget changes in `pi-orchestrator/extensions/orchestrator.ts`.
- TUI/status tests or snapshot fixtures where possible.

Responsibilities:

- Add run list, task board, task detail, transcript tail, diff summary, review results, and integration status views.
- Add actions for message/steer, interrupt/abort, restart/resume, review, merge selected, apply integration, and cleanup where the command surface already exists.
- Improve widget counts/activity, e.g. `mt: run login-refactor · 2 running · 1 attention · 3 ready`.
- Ensure transcript inspection does not dump full logs into model context.

Acceptance:

- Panel can render queued/running/attention/ready tasks from fixtures or live status.
- Transcript tails are inspectable.
- Widget uses stable status counts.
- Panel refreshes while open or has a clear refresh key.

### Segment 9 — Doctor, export, prune, and cleanup

Purpose: add operational recovery, diagnostics, and safe cleanup tooling.

Owns:

- `pi-orchestrator/src/multitask/doctor.js`.
- `pi-orchestrator/src/multitask/export.js`.
- Optional `pi-orchestrator/src/multitask/prune.js`.
- Diagnostics/export/prune tests.

Responsibilities:

- Implement doctor checks for Pi RPC availability, git state, daemon socket, stale pids, worktree root, config scripts, permissions, and foreground checkout cleanliness.
- Implement run export containing manifest, plan, reviews, events, transcripts, diffs, and integration metadata.
- Implement prune/cleanup dry-runs and confirmation-safe deletion paths.
- Produce actionable diagnostics and recovery instructions.

Acceptance:

- `/mt-doctor` can explain common broken states.
- `/mt-export <run-id>` works without live workers.
- `/mt-prune` previews destructive targets before deletion.
- Tests avoid real Pi worker credits.

### Segment 10 — Daemon/client/tool integration

Purpose: wire the isolated modules into the actual runtime. This is the main high-conflict integration segment and should happen after Segments 0–9 are stable enough to integrate.

Owns:

- `pi-orchestrator/src/multitask/daemon.js`.
- `pi-orchestrator/src/multitask/client.js`.
- `pi-orchestrator/extensions/orchestrator.ts` command/tool wiring.
- Targeted manifest/client tests.

Responsibilities:

- Implement `METHODS.SPAWN` using Segment 2 provisioning and Segment 1 scheduling.
- Enforce `maxConcurrency` in the daemon path.
- Use recovery classification in status/message paths.
- Support typed `multitask_message` envelopes and simple string compatibility.
- Add `restartIfNeeded` and `/mt-resume` behavior.
- Wire `/mt-agents`, `/mt-doctor`, `/mt-export`, and `/mt-prune` where applicable.
- Ensure workers do not receive multitask tools by default.
- Ensure project-local agent use follows trust rules.

Acceptance:

- `/mt-send` can message a spawned worker after it starts.
- Spawned tasks participate in review/merge/apply.
- `maxConcurrency` is enforced by the daemon.
- Status detects stale running tasks after daemon restart.
- Detached idle workers can be restarted from session directories.
- No-credit and smoke tests pass.

### Segment 11 — Merge/apply/review hardening

Purpose: harden the git-native integration promise after spawn/scheduler/recovery have landed.

Owns:

- `pi-orchestrator/src/multitask/merge.js`.
- Targeted review/merge/apply tests.
- Disposable fixture repositories for mock integration tests if useful.

Responsibilities:

- Confirm spawned task branches merge into the integration branch/worktree.
- Confirm integration validation scripts run at the correct boundaries.
- Preserve explicit approval and clean foreground checkout requirements for apply.
- Add checkpoint commits if the open decision is resolved in favor of them.
- Improve conflict, dirty-worktree, and cleanup failure messages.

Acceptance:

- Spawned task branches merge into the integration worktree.
- Integration validation scripts run and report clearly.
- `multitask_apply` refuses unsafe foreground checkouts by default.
- Cleanup leaves no orphaned worktrees in normal success/failure paths.

### Segment 12 — Packaging, README, and marketplace readiness

Purpose: finish the publishable extension experience.

Owns:

- `pi-orchestrator/README.md`.
- `pi-orchestrator/package.json`.
- Root `package.json` if needed.
- Package gallery metadata and release checklist docs.

Responsibilities:

- Add install, quickstart, examples, security, troubleshooting, update/remove, and recovery docs.
- Clearly differentiate Pi Multitask from `pi-subagents`, Taskplane, and pi-crew.
- Add screenshot/GIF/video metadata for the package gallery.
- Document trust boundaries, worktree fail-closed behavior, explicit apply approval, and cleanup dry-runs.
- Add release checklist covering tests, no-credit tests, smoke tests, package dry-run, and optional real Pi E2E.

Acceptance:

- README explains the value proposition and safe operating model clearly.
- Package dry-run includes only intended files.
- Real Pi E2E smoke is documented and gated behind an env var.
- Install/remove/update instructions are verified.

## Goal

Evolve the local `pi-orchestrator` / Pi Multitask extension into a polished Cursor-style multitask mode by borrowing the best marketplace ideas while preserving our differentiator:

> persistent local Pi RPC workers in isolated git worktrees, with deterministic review, integration branches/worktrees, and explicit merge/apply control back to the foreground checkout.

This plan builds on `specs/pi-multitask-mode-redesign.md` and focuses on marketplace parity, implementation gaps, and a release path.

## Competitive Baseline

### Packages reviewed

- `pi-subagents`: broadest and most popular general subagent package. Strong agent discovery, chains, parallel/background execution, clarify UI, status/interrupt/resume, prompt templates, intercom bridge, nested delegation controls, and optional worktree isolation.
- `@tintinweb/pi-subagents` / `@gotgenes/pi-subagents`: Claude Code-style `Agent` tool, live widget, conversation viewer, background steering/resume, custom agents, memory, scheduled agents, event bus, worktree isolation.
- `pi-crew`: durable team/workflow system with child Pi workers, async runs, worktree isolation, dashboard, resource management, import/export, metrics, doctor/config tooling, and trust-boundary rules.
- `taskplane`: task-batch orchestration with dependency DAGs, waves/lanes, checkpoint commits, worker/reviewer/merger roles, dashboard, file-based communication, and integration branch workflow.
- `pi-agents`: generic workflow graph model: spawn, sequence, fork, join, loop, persisted flows, watch/stop/mermaid views.
- `pi-agentteam`: visible tmux teammate model, leader-gated task board, typed assignment/question/inform messages, report_done/report_blocked, and explicit mailbox read boundaries.
- `@llblab/pi-actors`: durable spawn/message/inspect actor contract, addressable runs, mailboxes, artifacts, and rooms.
- Adjacent packages (`piolium`, `pi-letscook`, `gentle-pi`, `pi-feature-factory`, `pi-worktree`) show useful guardrails around resumable state, canonical evidence, phase discipline, worktree safety, and documentation polish.

### Our intended position

Do **not** compete as another generic subagent tool. Position Pi Multitask as:

- git-native local multitasking;
- persistent background workers that can be messaged after launch;
- isolated worker branches/worktrees;
- deterministic plus optional AI review;
- integration branch/worktree;
- explicit user-approved merge/apply;
- main Pi chat remains the supervisor.

## Current Strengths To Preserve

Keep and harden these existing parts:

- `src/multitask/rpc-worker-session.js`: persistent Pi RPC worker sessions using `prompt`, `steer`, `follow_up`, `abort`, `get_state`, and `get_messages`.
- `src/multitask/daemon.js` + `client.js`: repo-local daemon/client boundary.
- `src/multitask/manifest.js` + `events.js`: repo-local manifests, task state, transcripts, and events.
- `src/multitask/merge.js`: integration worktree, merge, validation, apply workflow.
- `src/multitask/review.js`: deterministic no-credit checks.
- `.pi/multitask/config.json`: explicit named startup/validation scripts.
- `extensions/orchestrator.ts`: tool/command surface, status widget, and `/mt-panel` foundation.

## Gaps To Address First

1. **`multitask_spawn` is a placeholder**
   - Implement adding a worker to an existing run.
   - Must create task state, worktree, branch, session dir, events, and start/queue the worker.

2. **Concurrency is not enforced by the new daemon path**
   - `manifest.maxConcurrency` exists but there is no real task queue/scheduler.
   - Add run-level queued/running accounting and a scheduler loop.

3. **Worker restart/resume is incomplete**
   - If the current daemon loses its in-memory worker handle, `multitask_message` cannot reattach.
   - Implement restart-from-session and/or revive-from-session-file semantics.

4. **`agent` is mostly a label**
   - Load role definitions from bundled, user, and project agents.
   - Respect model/thinking/tools/prompt/skills where possible.

5. **Review is deterministic only**
   - Keep deterministic review as baseline.
   - Add optional AI reviewer roles and review loops.

6. **TUI is snapshot-oriented**
   - Add live refresh, detail views, transcript tail, activity, and keyboard actions.

7. **No packaged marketplace polish**
   - Add screenshots/video metadata, release checklist, doctor command, and clear security notes.

## Feature Lifts By Competitor

### From `pi-subagents`

Adopt:

- Agent discovery and override model.
- Single/parallel/chain invocation vocabulary where it fits the multitask domain.
- Clarify/approval UI before starting workers.
- Background run status, interrupt, resume, and explicit async completion notifications.
- Prompt templates for common flows: parallel review, review loop, context build, cleanup.
- Child-safety boundaries: workers do not get multitask tools by default.

Do not copy:

- Generic delegation as the primary product surface.
- Deep nested subagent fanout by default.

### From `@tintinweb/pi-subagents`

Adopt:

- Rich worker widget with token/tool/activity summaries.
- Conversation/transcript viewer for a worker.
- Mid-run steering UX.
- Strict worktree isolation guarantee: if isolation cannot be created, fail instead of running unisolated.
- Event bus hooks for other extensions.

Consider later:

- Scheduled agents. Useful, but not core to multitask mode.
- Persistent role memory. Useful, but should not block MVP.

### From `taskplane`

Adopt:

- Dependency DAG and wave scheduling.
- Optional checkpoint commits at task/review boundaries.
- Worker/reviewer/merger role separation.
- Dashboard-like status model, even if initially TUI-only.
- Dedicated integration branch as a first-class output.

Defer or avoid:

- Polyrepo segmentation until monorepo/local-repo flow is excellent.
- Full external web dashboard unless TUI proves insufficient.

### From `pi-crew`

Adopt:

- Durable async runs that survive session switches/reloads.
- Resource management: create/update/delete agents/workflows.
- `doctor`, `validate`, `export`, `import`, and `prune` maintenance actions.
- Trust-boundary rules: project config must not override sensitive execution controls.
- Clear runtime modes for tests: real workers, mock/scaffold workers, no-credit mode.

Defer:

- Prometheus/OTLP metrics unless there is user demand.

### From `pi-agents`

Adopt:

- A small workflow graph model for advanced use:
  - `spawn`
  - `sequence`
  - `parallel`
  - `join`
  - `loop`
- Persisted flow tree views.
- Mermaid export for planning/debugging.

Constrain:

- Workflow nodes should produce multitask tasks and integration steps, not become a separate generic framework.

### From `pi-agentteam`

Adopt:

- Typed worker messages:
  - `assignment`
  - `question`
  - `inform`
  - `review_feedback`
  - `report_done`
  - `report_blocked`
- Explicit attention states for workers needing a user/supervisor decision.
- Task board semantics: leader/main chat owns task status transitions.

Do not require:

- tmux panes.

### From `pi-actors`

Adopt the conceptual API:

- `spawn`: create an addressable worker/task.
- `message`: steer or follow up.
- `inspect`: intentionally read state/logs/diffs/transcripts/artifacts.

Use this to simplify model guidance and tool naming consistency, while keeping existing `multitask_*` tools.

### From `pi-worktree`

Adopt:

- Strict worktree safety messaging.
- Better cleanup prompts.
- Clear path/worktree status in the UI.

## Target User Flows

### Flow A: User asks to multitask

1. Main agent inspects relevant code/specs.
2. Main agent proposes workers, dependencies, scripts, and review/merge plan.
3. Clarify UI or chat approval lets the user edit worker prompts/scripts/models.
4. `multitask_start` creates run state, worktrees, and queued workers.
5. Daemon scheduler starts up to `maxConcurrency` workers.
6. Main chat returns immediately.
7. Widget/panel shows live status.
8. Worker completion sends a compact follow-up notification.
9. Main agent reviews diffs and asks for merge/apply approval.

### Flow B: User adds another task mid-run

1. User or main agent calls `multitask_spawn`.
2. New task is appended to the manifest and task directory.
3. Scheduler starts it when capacity is available.
4. It can depend on selected prior tasks or base off current run base/integration.

### Flow C: Worker needs a decision

1. Worker emits/report message with `reason: need_decision` or `report_blocked`.
2. Task status becomes `needs_attention`.
3. Parent gets a follow-up notification.
4. User/main agent sends `multitask_message` with a decision.
5. Worker resumes.

### Flow D: Review and merge

1. `multitask_review` runs deterministic checks.
2. Optional AI reviewer runs for selected tasks.
3. Tasks become `ready_to_merge` only after checks pass.
4. `multitask_merge` merges task branches into integration worktree.
5. Integration validation scripts run.
6. `multitask_apply` requires explicit approval and clean foreground checkout by default.

## Proposed Architecture Changes

### 1. Scheduler

Add a scheduler module, likely `src/multitask/scheduler.js`, owned by the daemon.

Responsibilities:

- track run queues;
- enforce `maxConcurrency`;
- start queued workers;
- transition task states;
- handle worker exit/completion;
- retry/restart policy;
- emit run/task events;
- resume scheduling after daemon startup.

Initial state transitions:

```text
planned -> creating_worktree -> setup -> queued -> running -> idle/ready_for_review/needs_attention
```

Scheduler acceptance:

- With `maxConcurrency: 2` and 5 tasks, at most 2 worker processes run at once.
- When one worker completes or idles, the next queued worker starts.
- Status output includes queued/running counts.

### 2. Spawn implementation

Implement `METHODS.SPAWN` in `daemon.js`.

Steps:

1. Load manifest.
2. Normalize task input and validate id uniqueness.
3. Resolve scripts.
4. Create task record using existing manifest helpers or new helper.
5. Persist task state and manifest.
6. Create task worktree or enqueue worktree creation.
7. Hand off to scheduler.
8. Return compact task/run status.

Acceptance:

- `/mt-send` can message a spawned worker after it starts.
- Spawned task participates in review/merge/apply.

### 3. Resume/restart model

Add durable worker recovery.

Modes:

- **attached**: worker process exists in current daemon.
- **detached-idle**: session state exists, process not running, safe to restart with same session dir.
- **lost-running**: manifest says running but process is missing; mark `needs_attention` and offer restart.
- **completed**: can revive from session dir with a follow-up prompt.

Tool additions/changes:

- `multitask_resume` or `multitask_message` with `restartIfNeeded: true`.
- `/mt-resume <run-id> [task-id]`.

Acceptance:

- Stop daemon, start Pi again, run `/mt-status`; stale running tasks are detected.
- Sending a message to an idle detached task restarts a Pi RPC session from the persisted session dir.

### 4. Agent definitions

Add agent registry module, likely `src/multitask/agents.js`.

Discovery order:

1. bundled multitask agents in `pi-orchestrator/agents/*.md`;
2. user agents in `~/.pi/agent/agents/**/*.md`;
3. project agents in `.pi/agents/**/*.md` and optionally legacy `.agents/**/*.md`;
4. project overrides win only after approval/trust checks.

Support frontmatter subset:

```yaml
name: worker
description: Implementation worker
model: provider/model
thinking: high
tools: read,bash,edit,write,grep,find,ls
skills: some-skill, other-skill
systemPromptMode: replace|append
inheritProjectContext: true|false
maxTurns: 30
```

Worker launch should map agent config to Pi RPC args and appended prompt content.

Acceptance:

- `task.agent: "reviewer"` uses reviewer system prompt/tools.
- Project-local agents require confirmation in interactive mode and are blocked or require explicit opt-in in non-interactive mode.

### 5. Review loop

Keep deterministic review as mandatory baseline. Add optional AI review.

New config:

```json
{
  "review": {
    "mode": "deterministic" | "ai" | "both",
    "reviewerAgent": "reviewer",
    "maxRounds": 2,
    "requireDeterministicPass": true
  }
}
```

Review flow:

1. deterministic checks;
2. optional AI reviewer in fresh context, read-only tools by default;
3. if reviewer finds actionable changes, task becomes `needs_changes`;
4. user/main agent may send feedback to worker;
5. loop until clean or `maxRounds` reached.

Acceptance:

- No-credit tests still pass with deterministic mode.
- AI review is opt-in and clearly reported as credit-consuming.

### 6. Workflow graph and dependencies

Add optional advanced input to `multitask_start`:

```ts
{
  tasks: [...],
  dependencies?: Array<{ before: string, after: string }> // before must finish before after starts
}
```

Later support compact graph nodes:

```json
{
  "workflow": {
    "kind": "sequence",
    "steps": [
      { "kind": "parallel", "tasks": ["api", "ui"] },
      { "kind": "spawn", "task": "tests" },
      { "kind": "review" },
      { "kind": "merge" }
    ]
  }
}
```

Acceptance:

- Independent tasks run concurrently.
- Dependent tasks remain blocked until prerequisites reach `ready_for_review` or `ready_to_merge`, depending on policy.

### 7. Messaging and attention model

Extend `multitask_message` with a typed envelope while preserving simple string messages.

```ts
{
  runId: string,
  taskId: string,
  message: string,
  mode?: "steer" | "followUp",
  type?: "assignment" | "question" | "inform" | "review_feedback" | "decision",
  correlationId?: string
}
```

Worker reports should be normalized:

```ts
{
  status: "ready_for_review" | "needs_attention" | "blocked",
  reason?: "done" | "need_decision" | "blocked" | "error",
  summary: string,
  changedFiles?: string[],
  validation?: string
}
```

Acceptance:

- Worker decision requests appear in parent as compact follow-up messages.
- `/mt-panel` highlights attention tasks.

### 8. TUI and observability

Upgrade `/mt-panel` and widget.

Panel views:

- Runs list.
- Task board.
- Task detail.
- Transcript tail.
- Diff summary.
- Review results.
- Integration status.

Actions:

- message/steer;
- interrupt/abort;
- restart/resume;
- review;
- merge selected;
- apply integration;
- cleanup.

Widget:

```text
mt: run login-refactor · 2 running · 1 attention · 3 ready
```

Acceptance:

- Panel refreshes while open or has a clear refresh key.
- User can inspect worker transcript without dumping the full log into model context.

### 9. Doctor, export, cleanup, and release polish

Add:

- `/mt-doctor`: validates Pi RPC availability, git state, config, daemon socket, stale pids, worktree root, scripts, and permissions.
- `/mt-export <run-id>`: bundle manifest, plan, reviews, events, transcripts, diffs into a tar/zip or directory.
- `/mt-prune`: remove old runs/worktrees after confirmation.
- README marketplace section with security notes and screenshots/GIF.
- package gallery metadata: `image` or `video` in package `pi` manifest.

Acceptance:

- Users have a clear recovery path for stale daemons and broken worktrees.
- Package can be safely published or installed locally with documented trust boundaries.

## Security And Trust Boundaries

- Workers must keep `PI_MULTITASK_ROLE=worker` and should not receive multitask tools by default.
- Project-local agent definitions require confirmation before use.
- Project config may define scripts, but sensitive runtime controls should remain user-level or require approval:
  - unrestricted extra args;
  - custom Pi binary;
  - disabling safety confirmations;
  - auto-apply;
  - worker tool escalation.
- Worktree creation must fail closed. Never run a supposedly isolated worker in the foreground checkout when worktree creation fails.
- `multitask_apply` must require explicit user approval in interactive mode and require clean foreground checkout by default.
- Cleanup must preview destructive targets via dry-run where possible.

## Implementation Phases

### Phase 1 — Core gap closure

- Implement scheduler and enforce `maxConcurrency`.
- Implement `multitask_spawn`.
- Add stale worker detection to status.
- Add restart/resume from persisted session dirs.
- Expand tests for scheduler, spawn, stale daemon/process handling.

Deliverable: current feature set becomes reliable enough to re-enable for local dogfooding.

### Phase 2 — Agent registry and role prompts

- Implement bundled/user/project agent discovery.
- Make `task.agent` affect worker prompt/tools/model/thinking.
- Add project-agent trust prompts.
- Add `/mt-agents` list/show command.
- Add tests for agent precedence and trust behavior.

Deliverable: parity with common subagent packages for role definition basics.

### Phase 3 — Review and messaging improvements

- Add typed message envelope.
- Normalize worker reports and attention states.
- Add optional AI reviewer mode.
- Add review loop command/template.
- Add tests for deterministic-only and AI-review-disabled paths.

Deliverable: workers can ask for decisions and results can be reviewed with stronger optional checks.

### Phase 4 — TUI and observability polish

- Upgrade widget with live counts/activity.
- Upgrade `/mt-panel` with detail/transcript/diff/review views.
- Add worker transcript viewer.
- Add `/mt-doctor`.
- Add event bus hooks for extension interop.

Deliverable: user experience is competitive with marketplace subagent widgets/status views.

### Phase 5 — Workflow graph and dependency scheduling

- Add task dependencies.
- Add wave scheduling.
- Add small workflow graph input and persisted flow tree.
- Add Mermaid export for run/workflow.
- Add optional checkpoint commits.

Deliverable: compete with Taskplane/pi-agents for structured orchestration while preserving git-native integration.

### Phase 6 — Packaging and marketplace readiness

- Add gallery image/video metadata.
- Update README with install, quickstart, security, examples, and troubleshooting.
- Add release checklist: tests, no-credit tests, smoke tests, package dry-run.
- Decide package name and publication path.
- Validate with real Pi worker E2E in a disposable repo.

Deliverable: publishable extension with clear differentiation.

## Testing Strategy

Maintain three tiers:

1. **No-credit unit tests**
   - scheduler;
   - manifest/state transitions;
   - spawn;
   - agent discovery;
   - review deterministic checks;
   - stale daemon cleanup;
   - config validation.

2. **Mock worker integration tests**
   - worktree creation;
   - queued worker lifecycle;
   - merge/apply with fake changes;
   - cleanup.

3. **Optional real Pi E2E**
   - gated behind env var;
   - disposable git repo;
   - starts real `pi --mode rpc` worker;
   - sends follow-up;
   - reviews/merges/applies.

Existing scripts should be preserved and extended:

```bash
npm run test:multitask-no-credit
npm test
npm run test:orchestrator-smoke
PI_MULTITASK_REAL_E2E=1 npm run test:multitask-real
```

## Suggested New/Changed Files

```text
pi-orchestrator/src/multitask/scheduler.js
pi-orchestrator/src/multitask/agents.js
pi-orchestrator/src/multitask/workflow.js
pi-orchestrator/src/multitask/doctor.js
pi-orchestrator/src/multitask/export.js
pi-orchestrator/src/multitask/recovery.js
pi-orchestrator/src/multitask/messages.js
pi-orchestrator/agents/worker.md
pi-orchestrator/agents/reviewer.md
pi-orchestrator/agents/scout.md
pi-orchestrator/agents/merger.md
pi-orchestrator/prompts/parallel-review.md
pi-orchestrator/prompts/review-loop.md
```

Existing files that will need significant edits:

```text
pi-orchestrator/extensions/orchestrator.ts
pi-orchestrator/src/multitask/daemon.js
pi-orchestrator/src/multitask/client.js
pi-orchestrator/src/multitask/manifest.js
pi-orchestrator/src/multitask/rpc-worker-session.js
pi-orchestrator/src/multitask/review.js
pi-orchestrator/src/multitask/tui-state.js
pi-orchestrator/README.md
pi-orchestrator/package.json
package.json
```

## Milestone Acceptance Checklist

Before re-enabling by default locally:

- [ ] `multitask_spawn` works end-to-end.
- [ ] `maxConcurrency` is enforced.
- [ ] daemon restart/status detects stale running tasks.
- [ ] detached idle workers can be restarted from session dir.
- [ ] project-local agents require approval.
- [ ] `/mt-panel` can inspect task details and transcript tails.
- [ ] deterministic review, merge, and apply work after spawned tasks.
- [ ] `/mt-doctor` gives actionable diagnostics.
- [ ] all no-credit and smoke tests pass.

Before publishing:

- [ ] README clearly differentiates Pi Multitask from `pi-subagents`, Taskplane, and pi-crew.
- [ ] security/trust boundary documented.
- [ ] package gallery image/video added.
- [ ] npm/package dry-run includes only intended files.
- [ ] real Pi E2E smoke passes in a disposable repo.
- [ ] install/remove/update instructions verified.

## Open Decisions

1. Should AI review use our own worker session machinery or invoke a reviewer through a separate child process?
2. Should `pi-subagents` interop be optional, or should Pi Multitask remain fully standalone?
3. Should workflows be first-class user-authored files, or only an advanced JSON field to `multitask_start`?
4. Should checkpoint commits be automatic, opt-in, or only done at merge preparation?
5. Should the daemon become a truly detached OS process, or remain in-process with robust restart/recovery?
6. What package name should be used if published: `pi-multitask`, `pi-orchestrator`, or scoped package?

## Recommended Next Step

Start with Phase 1. The marketplace already has polished generic subagents; our credibility depends on making the core multitask promise reliable:

> start local workers, keep chatting, steer them, recover them, review them, merge them safely.
