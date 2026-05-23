# Pi Orchestrator Extension / Agent Discussion

This document captures the proposed architecture and implementation plan for a Pi orchestrator extension/agent that can decompose large specs into worker tasks, optionally run workers in separate Git worktrees, and optionally merge/integrate the results.

## Goal

Build a Pi orchestrator package that:

1. Exposes one main agent for the user to talk to.
2. Lets that main agent delegate to sub-agent workers with full project read/write access.
3. Optionally gives each worker its own Git worktree.
4. Optionally provides merge/sync/integration behavior through an extension/tool.

Main use case:

- User creates a planning branch/worktree.
- User writes one or more large spec documents.
- User talks to the orchestrator.
- Orchestrator splits work into tasks.
- Orchestrator dispatches tasks to workers.
- Workers implement in parallel.
- Orchestrator reviews, integrates, and optionally merges the results.

## Relevant Pi Capabilities

Pi supports this well through extensions and the SDK.

Important extension capabilities:

- Register custom tools with `pi.registerTool()`.
- Register slash commands with `pi.registerCommand()`.
- Spawn subprocesses with `pi.exec()` or Node child processes.
- Inject system-prompt guidance with `before_agent_start`.
- Add TUI widgets/status lines for progress.
- Persist extension state with `pi.appendEntry()` or files under `.pi/`.
- Use session events and tool events for lifecycle tracking.

Pi already includes a subagent example:

```text
/usr/local/lib/node_modules/@mariozechner/pi-coding-agent/examples/extensions/subagent/
```

That example registers a `subagent` tool and spawns separate `pi --mode json -p --no-session` worker processes. It supports single, parallel, and chained subagent calls.

This orchestrator idea can build on that foundation.

## Recommended Architecture

### 1. Main Interactive Session Is the Orchestrator

The user continues talking to one normal Pi session.

An orchestrator extension makes the main agent orchestration-aware by registering tools such as:

- `orchestrator_plan`
- `orchestrator_dispatch`
- `orchestrator_status`
- `orchestrator_review`
- `orchestrator_merge`
- `orchestrator_cleanup`

It may also register commands such as:

- `/orchestrate`
- `/orch-status`
- `/orch-merge`
- `/orch-cleanup`

Example user prompt:

```text
Please implement @specs/permissions.md using the orchestrator.
Split it into parallel workstreams, use worktrees, then merge the results.
```

The main agent would:

1. Read the specs.
2. Decompose the work.
3. Ask for approval.
4. Dispatch worker agents.
5. Collect results.
6. Optionally review and merge.

### 2. Worker Agents

There are two viable worker implementation strategies.

#### Option A: Spawn Pi Subprocesses

Each worker is a separate Pi process:

```bash
pi --mode json -p --no-session \
  --append-system-prompt /tmp/worker-system-prompt.md \
  --model claude-sonnet-4-5 \
  "Task: implement X"
```

Pros:

- Simple.
- Process isolation.
- Each worker has an isolated context window.
- Easy to set `cwd` to a worktree.
- Uses normal Pi auth and tools.
- Matches Pi's existing subagent example.

Cons:

- Subprocess overhead.
- Need to parse JSON-mode events.
- Need care around extension loading in worker processes.

This is the best MVP path.

#### Option B: Use Pi SDK Sessions

A companion CLI or extension could create SDK sessions:

```ts
createAgentSession({
  cwd: workerWorktree,
  tools: createCodingTools(workerWorktree),
  sessionManager: SessionManager.inMemory(),
})
```

Pros:

- Better structured control.
- Direct event stream.
- Easier long-lived orchestration state.
- Explicit tool sets per worker.

Cons:

- More code.
- More runtime complexity.

Start with subprocess workers. Consider SDK later if subprocesses become limiting.

Quick community research note: existing Pi subagent/orchestrator projects mostly use subprocess workers, while at least one notable implementation uses in-process Pi SDK sessions. To avoid locking into either approach, the orchestrator should define a `WorkerRunner` interface from the beginning. Production MVP can use a `PiSubprocessWorkerRunner`; tests can use a `MockWorkerRunner`; a future `SdkSessionWorkerRunner` can be added without changing orchestration, worktree, hook, or merge logic.

## Worktree Strategy

For parallel write workers, separate worktrees should usually be the default.

Multiple subagents writing to the same checkout can clobber each other. Pi's built-in file mutation queue only coordinates within one process, not across multiple spawned Pi workers.

Recommended layout:

```text
repo/
  .pi/
    orchestrator/
      runs/
        2026-05-23-abc123/
          manifest.json
          plan.md
          workers/
            api.md
            ui.md
            tests.md

../repo-orch-worktrees/
  2026-05-23-abc123/
    api/
    ui/
    tests/
    integration/
```

Recommended branch names:

```text
orch/2026-05-23-abc123/api
orch/2026-05-23-abc123/ui
orch/2026-05-23-abc123/tests
orch/2026-05-23-abc123/integration
```

Each worker gets:

- its own `cwd`
- its own worktree
- its own branch
- full read/write/bash tools
- a scoped task prompt
- instructions to commit its changes
- instructions to output a summary and changed files

## Worktree Startup Hooks

Users need a way to run setup commands whenever the orchestrator creates a new worktree.

Examples:

- `npm install`
- `pnpm install`
- `yarn install`
- `poetry install`
- `bundle install`
- `mise install`
- `direnv allow`
- project-specific bootstrap scripts

Recommended config file:

```json
{
  "worktrees": {
    "root": "../repo-orch-worktrees",
    "startupHooks": [
      {
        "name": "install dependencies",
        "command": "npm install",
        "timeoutSeconds": 600
      }
    ]
  }
}
```

Suggested location:

```text
.pi/orchestrator/config.json
```

Hook behavior:

1. Run after `git worktree add` succeeds.
2. Run before the worker agent starts.
3. Run with `cwd` set to the new worktree path.
4. Run hooks sequentially by default.
5. Capture stdout/stderr into the run manifest.
6. Stop worker startup if a required hook fails.
7. Allow optional hooks that warn but do not fail the run.

Extended hook shape:

```json
{
  "name": "install python dependencies",
  "command": "poetry install",
  "timeoutSeconds": 900,
  "required": true,
  "env": {
    "PIP_DISABLE_PIP_VERSION_CHECK": "1"
  },
  "runFor": ["worker", "integration"]
}
```

Fields:

- `name`: human-readable label.
- `command`: shell command to run.
- `timeoutSeconds`: optional timeout.
- `required`: if `true`, hook failure blocks worker startup. Default `true`.
- `env`: extra environment variables.
- `runFor`: optional list controlling which worktree types run this hook.
  - `worker`
  - `integration`
  - `review`
  - `merge`

Potential future additions:

- `condition`: only run when certain files exist, such as `package.json` or `pyproject.toml`.
- `cacheKey`: skip hook if dependency lockfile has not changed.
- `parallel`: allow independent hooks to run concurrently.
- `interactive`: allow hooks that require terminal interaction, default `false`.

The orchestrator should include hook results in the worker prompt, for example:

```text
Worktree setup completed.
Startup hooks:
- install dependencies: succeeded in 42s
```

If setup fails, the worker should not start. The orchestrator should report the failing hook and ask the user whether to retry, skip, edit config, or abort.

## Planning Branch and Spec Docs

If the user has uncommitted spec docs in a planning worktree, newly created Git worktrees will not automatically see those uncommitted files.

Possible policies:

### Strict Policy

Require a clean repo before dispatch:

```text
Please commit or stash your planning/spec changes before starting workers.
```

This is simplest and safest.

### WIP Snapshot Policy

Create a temporary WIP commit before creating worker branches:

```bash
git add specs/
git commit -m "orchestrator: planning snapshot"
```

Convenient, but mutates the user's planning branch.

### Patch-Copy Policy

Capture uncommitted changes as patches and apply them to each worker worktree:

```bash
git diff --binary > planning.patch
git diff --cached --binary > staged.patch
```

Then in each worktree:

```bash
git apply planning.patch
```

More flexible, but has edge cases with untracked files.

MVP recommendation: require a clean repo by default, with optional `snapshotWip` or patch-copy modes later.

## Proposed Workflow

### Step 1: User Starts From Planning Branch

Example:

```bash
git checkout -b planning/big-feature
```

Specs:

```text
specs/feature.md
specs/api.md
specs/ui.md
```

User asks Pi:

```text
Use the orchestrator to implement @specs/feature.md. Split into worktrees and merge when ready.
```

### Step 2: Main Agent Plans

The orchestrator reads specs and creates a decomposition:

```md
# Orchestrator Plan

Base ref: planning/big-feature @ abc123

## Tasks

### api
Implement backend API changes.
Likely files:
- src/server/routes/...
- src/domain/...

### ui
Implement UI screens.
Likely files:
- src/app/...
- src/components/...

### tests
Add integration and unit tests.
Likely files:
- tests/...
```

The main agent asks for confirmation before launching workers.

### Step 3: Dispatch Workers

Example tool call shape:

```ts
orchestrator_dispatch({
  runName: "big-feature",
  baseRef: "HEAD",
  worktreeMode: "per-task",
  tasks: [
    {
      id: "api",
      agent: "worker",
      task: "Implement the backend API portion of specs/feature.md..."
    },
    {
      id: "ui",
      agent: "worker",
      task: "Implement the UI portion of specs/feature.md..."
    },
    {
      id: "tests",
      agent: "worker",
      task: "Add tests for the new feature..."
    }
  ]
})
```

Workers run in separate worktrees and commit to separate branches.

### Step 4: Worker Output Contract

Workers should finish with a predictable Markdown structure:

```md
## Completed

Implemented X.

## Files Changed

- `src/foo.ts` — added Y
- `src/bar.ts` — refactored Z

## Validation

- Ran `npm test`
- Ran `npm run typecheck`

## Commit

`orch/2026-05-23-abc123/api` at `def456`

## Notes

Potential conflict with UI branch in `src/routes.ts`.
```

This is good enough for MVP. Later, a final structured-output tool could enforce stricter reporting.

## Worker Verification and Automated Orchestrator Testing

The implementing agent needs a way to verify the orchestrator without manually starting interactive Pi orchestration sessions.

Recommended approach: design the orchestrator with a testable core plus a non-interactive smoke-test harness.

### Separate Core Logic From Pi UI

Split implementation into layers:

```text
pi-orchestrator/
  extensions/
    orchestrator.ts          # Pi extension entrypoint: tools, commands, UI
  src/
    config.ts                # load/validate config
    git.ts                   # worktree/branch/merge helpers
    hooks.ts                 # startup hook runner
    manifest.ts              # run state persistence
    planner-types.ts         # task/run schemas
    worker-runner.ts         # worker runner interface
    runners/
      pi-subprocess.ts       # real Pi worker runner
      mock.ts                # deterministic test worker runner
    merge.ts                 # integration merge logic
  test/
    fixtures/
    *.test.ts
```

The extension should be thin. Most behavior should be callable from tests without loading Pi interactively.

### Worker Runner Interface

Define a worker runner abstraction:

```ts
interface WorkerRunner {
  runWorker(input: WorkerRunInput): Promise<WorkerRunResult>;
}
```

Implementations:

1. `PiSubprocessWorkerRunner`: real MVP implementation that spawns `pi --mode json -p --no-session`.
2. `MockWorkerRunner`: deterministic implementation used by tests.
3. `SdkSessionWorkerRunner`: optional future implementation using Pi SDK `createAgentSession()` for in-process workers.

The mock runner can simulate workers by applying scripted file changes, creating commits, and returning realistic summaries.

This lets the implementing agent run fast tests without consuming LLM/API calls.

### Non-Interactive Smoke Test Command

Add a package script that creates a temporary Git repo and runs the orchestrator end-to-end in mock mode:

```bash
npm run test:orchestrator-smoke
```

The smoke test should:

1. Create a temp directory.
2. Initialize a Git repo.
3. Add a tiny fixture project.
4. Commit a spec file.
5. Create an orchestrator config with startup hooks.
6. Start an orchestrator run using mock workers.
7. Verify worktrees were created.
8. Verify startup hooks ran.
9. Verify worker branches were created.
10. Verify mock workers committed changes.
11. Run integration merge.
12. Verify the final integrated tree contains expected files.
13. Verify the manifest records all key steps.
14. Clean up temp worktrees.

Example fixture:

```text
fixture repo before:
  package.json
  src/math.ts
  specs/add-subtract.md

mock worker tasks:
  api/add -> writes src/add.ts
  api/subtract -> writes src/subtract.ts
  tests -> writes test/math.test.ts

expected integrated result:
  src/add.ts
  src/subtract.ts
  test/math.test.ts
```

### Real Pi E2E Test Should Be Optional

A real LLM-backed E2E test is useful but should not be required for normal development.

Suggested scripts:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:orchestrator-smoke": "vitest run test/orchestrator-smoke.test.ts",
    "test:orchestrator-real": "PI_ORCHESTRATOR_REAL_E2E=1 vitest run test/orchestrator-real.test.ts"
  }
}
```

Rules:

- `npm test` uses mock workers only.
- `npm run test:orchestrator-smoke` uses mock workers only.
- `npm run test:orchestrator-real` may spawn real `pi` workers and use API credits.
- Real E2E tests are skipped unless an explicit env var is set.

### Orchestrator Dry Run

Add a dry-run mode for the main tool/command:

```ts
orchestrator_dispatch({
  runName: "example",
  dryRun: true,
  worktreeMode: "per-task",
  tasks: [...]
})
```

Dry run should report:

- intended run ID
- base branch/ref
- worktree paths
- branch names
- startup hooks that would run
- worker commands that would be spawned
- merge plan

It should not create worktrees or modify files.

### Orchestrator Verify Command

Add a verification command/tool:

```text
/orch-verify <run-id>
```

or:

```ts
orchestrator_verify({ runId: "..." })
```

It should check:

- manifest exists and is valid
- all declared worktrees exist
- worker branches exist
- worker commits exist
- startup hooks completed or failed as recorded
- dirty worktrees are reported
- integration branch status
- configured validation commands pass

### Validation Commands

In addition to startup hooks, users should be able to define verification commands.

Example config:

```json
{
  "validation": {
    "worker": [
      { "name": "typecheck", "command": "npm run typecheck", "timeoutSeconds": 300 },
      { "name": "unit tests", "command": "npm test", "timeoutSeconds": 600 }
    ],
    "integration": [
      { "name": "full test suite", "command": "npm test", "timeoutSeconds": 900 }
    ]
  }
}
```

Behavior:

- Worker validation runs inside each worker worktree after the worker finishes.
- Integration validation runs inside the integration worktree after merges.
- Results are captured in the manifest.
- Failures are visible in status and summaries.
- Validation results are included in follow-up prompts if a worker needs to fix its branch.

### Implementation-Agent Acceptance Criteria

When an agent is implementing the orchestrator extension, it should be able to verify its work by running:

```bash
npm test
npm run test:orchestrator-smoke
```

No manual Pi session should be required for this baseline verification.

For optional real-world verification:

```bash
npm run test:orchestrator-real
```

The spec for the implementing agent should explicitly say:

```text
Do not consider the task complete until the mock smoke test passes. Do not require the user to manually launch Pi sessions to verify baseline behavior.
```

### Step 5: Review

Optional reviewer flow:

```text
worker -> reviewer -> worker fixups -> ready
```

Reviewer agent can:

- inspect worker branch
- run tests
- produce merge-readiness report
- identify conflicts or missing pieces

### Step 6: Integration Merge

Avoid having workers merge directly into the user's active branch.

Instead:

1. Create an integration worktree.
2. Merge worker branches one by one.
3. Run tests after each merge or after all merges.
4. If conflicts occur, stop or spawn a merger/resolver worker.
5. Produce final report.
6. Ask user before merging integration branch back into the original branch.

Example:

```bash
git worktree add ../repo-orch-worktrees/run/integration -b orch/run/integration HEAD
cd ../repo-orch-worktrees/run/integration

git merge --no-ff orch/run/api
npm test

git merge --no-ff orch/run/ui
npm test

git merge --no-ff orch/run/tests
npm test
```

Then the main agent reports:

```text
Integration branch ready: orch/run/integration
All tests passing.
Merge into planning/big-feature?
```

## Proposed Package Shape

This repo could add a new package folder:

```text
pi-orchestrator/
  package.json
  README.md
  extensions/
    orchestrator.ts
  agents/
    orchestrator.md
    worker.md
    reviewer.md
    merger.md
    scout.md
  prompts/
    orchestrate.md
    orchestrate-worktrees.md
    orchestrate-review-merge.md
```

Root `package.json` could be updated to include:

```json
{
  "pi": {
    "extensions": [
      "pi-dcg/extensions",
      "pi-web-tools/extensions",
      "pi-ask-question/extensions",
      "pi-orchestrator/extensions"
    ],
    "prompts": [
      "pi-orchestrator/prompts"
    ]
  }
}
```

Note: Pi has built-in discovery for extensions, prompts, skills, and themes. “Agents” are not a built-in Pi resource type. The existing subagent example implements its own discovery from:

```text
~/.pi/agent/agents/*.md
.pi/agents/*.md
```

The orchestrator can reuse that pattern.

## Worker Extension Loading / Recursion

If the orchestrator extension is globally installed, spawned worker Pi processes will also load it by default. This can accidentally allow recursive delegation:

```text
main orchestrator -> worker -> worker sees orchestrator tool -> worker delegates again
```

Possible mitigations:

### Simple Tool Restriction

Pass explicit worker tools:

```bash
--tools read,bash,edit,write,grep,find,ls
```

### Worker Role Environment Variable

Spawn workers with:

```bash
PI_ORCHESTRATOR_ROLE=worker
```

Then in the extension:

```ts
if (process.env.PI_ORCHESTRATOR_ROLE === "worker") {
  // Do not register orchestrator tools.
  return;
}
```

### Explicit Extension Loading

Spawn with:

```bash
pi --no-extensions -e ./worker-support.ts ...
```

This is most controlled, but then we must explicitly load any worker extensions we want.

Recommendation: use both env guard and tool restriction by default. Add `allowWorkerDelegation: true` later only if recursive orchestration is desired.

## State Model

Persist orchestration state outside the LLM conversation.

Example manifest:

```json
{
  "runId": "2026-05-23-abc123",
  "baseRef": "abc123",
  "baseBranch": "planning/big-feature",
  "status": "running",
  "tasks": [
    {
      "id": "api",
      "branch": "orch/2026-05-23-abc123/api",
      "worktree": "../repo-orch-worktrees/2026-05-23-abc123/api",
      "status": "completed",
      "commit": "def456",
      "summary": "..."
    }
  ],
  "integration": {
    "branch": "orch/2026-05-23-abc123/integration",
    "worktree": "../repo-orch-worktrees/2026-05-23-abc123/integration",
    "status": "pending"
  }
}
```

Suggested location:

```text
.pi/orchestrator/runs/<run-id>/manifest.json
```

This makes runs resumable after Pi exits.

## MVP Roadmap

### MVP 1: Managed Subagents

- Add `orchestrator_dispatch`.
- Support parallel workers.
- Run workers in current cwd or specified cwd.
- Collect summaries.
- No worktrees yet, or worktrees behind a flag.

### MVP 2: Worktree Workers

- Create one worktree per task.
- Require clean repo.
- Create worker branches.
- Require workers to commit.
- Add status command/tool.

### MVP 3: Integration Merge

- Create integration worktree.
- Merge worker branches sequentially.
- Run configured test command.
- Stop on conflict.
- Report result.

### MVP 4: Conflict Resolution Worker

- Spawn `merger` agent in integration worktree.
- Give it conflict context.
- Let it resolve, run tests, and commit.

### MVP 5: Polish

- TUI status widget.
- Slash commands.
- Persisted run history.
- Cleanup command.
- Reviewer workflow.
- Project-local agent definitions.
- Config file.

## Main Risk Areas

### 1. Uncommitted Planning State

Need a deliberate policy.

Recommendation: require clean repo for MVP.

### 2. Worker Branch Conflicts

Expected. Integration worktree handles this cleanly.

### 3. Workers Modifying Overlapping Files

Worktrees protect the physical checkout, but merge conflicts still happen.

The planner should assign file ownership per task:

```md
Task api owns:
- src/server/**
- src/domain/**

Task ui owns:
- src/app/**
- src/components/**

Shared files requiring coordination:
- package.json
- routes.ts
```

### 4. Extension Recursion

Workers should not get orchestrator tools by default.

### 5. Dangerous Commands

Workers with full bash can do anything. If workers are spawned with `--no-extensions`, safety extensions such as `pi-dcg` may not apply. Decide deliberately whether workers inherit safety extensions.

## Recommendation

Build this as a Pi package extension first, not as a separate app.

Use Pi's existing subagent example as the foundation, then add:

1. Run manifest persistence.
2. Worktree creation.
3. Worker branch/commit requirements.
4. Integration merge command/tool.
5. Orchestrator prompt guidance.
6. Worker-role environment guard.

Desired final UX:

```text
/orchestrate-worktrees @specs/big-feature.md
```

Then the main agent:

1. Reads specs.
2. Proposes task decomposition.
3. Asks approval.
4. Creates worktrees.
5. Dispatches workers.
6. Summarizes results.
7. Optionally reviews.
8. Asks whether to integrate.
9. Merges into an integration branch.
10. Asks whether to merge back into the user's planning branch.

This balances automation with user control.
