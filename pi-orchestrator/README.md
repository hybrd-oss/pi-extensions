# Pi Multitask (`pi-orchestrator`)

Pi Multitask is a Pi extension package for Cursor-style local multitask mode. It lets the main Pi chat stay in charge while persistent background Pi workers implement independent pieces of work in isolated git worktrees, then brings their results back through deterministic review, an integration worktree, and explicit user-approved apply.

Pi Multitask is intentionally **not** a generic subagent launcher. Its core promise is git-native local parallelism with safe integration:

- **Persistent local Pi RPC workers** that can be monitored, steered, resumed, or restarted after launch.
- **Fail-closed worktree isolation** for every worker branch: if an isolated worktree cannot be created, the worker is not run in your foreground checkout.
- **Queueing and dependencies** with `maxConcurrency`, wave-style scheduling, and `multitask_spawn` for adding tasks mid-run.
- **Deterministic no-credit review** as the default gate, with optional AI review when explicitly configured.
- **Integration branch/worktree** before foreground changes are applied.
- **Explicit apply approval** and clean-checkout requirements before touching the user's current checkout.
- **Cleanup dry-runs** for worktree/state deletion.

## Install

> **Security:** Pi packages run with full system access. This package registers an extension that can spawn local `pi` worker processes and run explicitly configured shell scripts. Review the source before installing and only install packages you trust.

### From npm, once published

```bash
pi install npm:@mbattagl/pi-orchestrator
pi list
```

Pinned installs skip package updates:

```bash
pi install npm:@mbattagl/pi-orchestrator@0.1.0
```

### From this checkout for development

From the repository root:

```bash
pi install ./pi-orchestrator
# or try it for one Pi session only:
pi -e ./pi-orchestrator
```

Use `-l` with `pi install` if you want the package recorded in project settings (`.pi/settings.json`) instead of global settings (`~/.pi/agent/settings.json`).

### Update and remove

Use the same source identity you installed:

```bash
# npm package
pi update npm:@mbattagl/pi-orchestrator
pi remove npm:@mbattagl/pi-orchestrator

# local development path
pi update ./pi-orchestrator
pi remove ./pi-orchestrator

# all non-pinned packages
pi update --extensions
```

Reload Pi after installing or updating so the extension, commands, prompts, and status widget are loaded:

```text
/reload
```

## Quickstart

1. Start Pi in a git repository with a clean or intentionally managed checkout.
2. Ask Pi to multitask a request:

   ```text
   /mt Refactor the auth flow. Split API, UI, and tests into separate workers.
   ```

3. The supervisor agent should inspect the code, propose workers, list selected startup/validation scripts, and ask for approval.
4. After approval, `multitask_start` creates `.pi/multitask` run state, worker branches/worktrees, and queued persistent worker sessions.
5. Continue using the main chat while workers run. Inspect status with:

   ```text
   /mt-status
   /mt-panel
   ```

6. Steer a worker if needed:

   ```text
   /mt-send <run-id> <task-id> Please keep the public API backwards compatible.
   ```

7. Review, merge into the integration worktree, and apply only after checking the result:

   ```text
   /mt-review <run-id>
   /mt-diff <run-id>
   /mt-merge <run-id>
   /mt-apply <run-id>
   ```

`/mt-apply` prompts in interactive Pi and the underlying tool requires explicit approval. By default it refuses to apply over a dirty foreground checkout.

## Commands

- `/multitask <request>` / `/mt <request>` — ask the current Pi supervisor to use multitask mode.
- `/mt-panel` — open the task board/panel.
- `/mt-status [run-id]` — list runs or show one run, including daemon/recovery health.
- `/mt-send <run-id> <task-id> [message] [--restart]` — steer or follow up with a worker; `--restart` asks Pi Multitask to restart a detached worker from its session directory before sending.
- `/mt-resume <run-id> [task-id] [message]` — resume/restart restartable detached workers.
- `/mt-agents` — list bundled/user/project role agents and trust provenance.
- `/mt-diff <run-id> [task-id]` — show task or integration diffs and changed-file summaries.
- `/mt-review <run-id> [task-id]` — run review gates for one task or all reviewable tasks.
- `/mt-merge <run-id> [task-id...]` — merge ready task branches into the integration worktree.
- `/mt-apply <run-id>` — apply the integration branch/worktree back to the foreground checkout after approval.
- `/mt-cancel <run-id> [task-id]` — cancel a worker or whole run.
- `/mt-doctor [run-id]` — diagnose daemon, git, worktree, script, and recovery issues.
- `/mt-export <run-id> [output-path]` — export run evidence: manifest, plan, events, transcripts, diffs, reviews, and integration metadata.
- `/mt-cleanup <run-id> [--state] [--dry-run]` — cleanup one run; preview first with `--dry-run`.
- `/mt-prune [run-id] [--all] [--state] [--worktrees] [--delete] [--force]` — preview or prune old runs/worktrees. Without `--delete`, this is a dry-run.
- `/mt-config [show|validate|init|add-script|set-defaults]` — manage named startup/validation scripts.

## Tools

The extension registers these model tools:

- `multitask_start` — create a run, worktrees, integration worktree, and queued persistent workers.
- `multitask_spawn` — add a worker to an existing run.
- `multitask_message` — send a typed or plain steer/follow-up message to a worker.
- `multitask_resume` — restart detached workers from persisted session directories.
- `multitask_status` — inspect runs/tasks and daemon health.
- `multitask_diff` — inspect task/integration diffs.
- `multitask_review` — run deterministic and optionally AI review gates.
- `multitask_merge` — merge task branches into integration.
- `multitask_apply` — apply integration to the foreground checkout, requiring explicit approval.
- `multitask_cancel` — cancel a worker or run.

Operational commands also call daemon methods for agents, doctor, export, cleanup, and prune.

## Configuration

Create `.pi/multitask/config.json` in a project to define worktree location and named scripts:

```json
{
  "worktrees": {
    "root": "../repo-multitask-worktrees"
  },
  "scripts": {
    "frontend:setup": {
      "command": "pnpm install",
      "cwd": "apps/frontend",
      "timeoutSeconds": 600
    },
    "backend:setup": {
      "command": "poetry install",
      "cwd": "services/backend",
      "timeoutSeconds": 900
    },
    "frontend:test": {
      "command": "pnpm test",
      "cwd": "apps/frontend",
      "timeoutSeconds": 600
    },
    "backend:test": {
      "command": "pytest",
      "cwd": "services/backend",
      "timeoutSeconds": 600
    }
  },
  "defaults": {
    "workerStartupScripts": [],
    "workerValidationScripts": [],
    "integrationStartupScripts": [],
    "integrationValidationScripts": []
  },
  "review": {
    "mode": "deterministic",
    "requireDeterministicPass": true
  }
}
```

Scripts are deliberately explicit. Pi Multitask does **not** auto-detect install/test commands; the supervisor should show selected named scripts before starting workers.

Example `multitask_start` shape:

```json
{
  "runName": "auth-refactor",
  "maxConcurrency": 2,
  "tasks": [
    {
      "id": "api",
      "agent": "worker",
      "prompt": "Refactor the auth API while preserving public behavior.",
      "startupScripts": ["backend:setup"],
      "validationScripts": ["backend:test"]
    },
    {
      "id": "ui",
      "agent": "worker",
      "prompt": "Update the login UI to use the refactored auth API.",
      "dependencies": ["api"],
      "startupScripts": ["frontend:setup"],
      "validationScripts": ["frontend:test"]
    }
  ],
  "integration": {
    "startupScripts": ["backend:setup", "frontend:setup"],
    "validationScripts": ["backend:test", "frontend:test"]
  }
}
```

## Examples

### Parallel workers with a review loop

```text
/mt Split this change into API, UI, and docs workers. Require deterministic review before merge.
/mt-status
/mt-review auth-refactor
/mt-merge auth-refactor api ui docs
/mt-apply auth-refactor
```

### Add a task mid-run

Ask the supervisor in chat to add a task, or use the tool directly:

```json
{
  "runId": "auth-refactor",
  "id": "regression-tests",
  "prompt": "Add regression coverage for the new auth behavior.",
  "dependencies": ["api", "ui"],
  "validationScripts": ["frontend:test", "backend:test"]
}
```

### Recover after closing Pi

```text
/mt-status auth-refactor
/mt-doctor auth-refactor
/mt-resume auth-refactor api Please continue from the saved session state.
```

Status/doctor output classifies workers as attached, detached idle, lost running, or completed and suggests restart/resume actions when possible.

### Cleanup safely

```text
/mt-cleanup auth-refactor --dry-run
/mt-cleanup auth-refactor
/mt-prune --all
/mt-prune --all --delete
```

Preview destructive targets first. `--state` also removes `.pi/multitask/runs/<run-id>` state; otherwise cleanup focuses on worktrees.

## State layout

Runs and daemon state are stored in the repository:

```text
.pi/multitask/daemon.sock
.pi/multitask/daemon.pid
.pi/multitask/runs/<run-id>/manifest.json
.pi/multitask/runs/<run-id>/plan.md
.pi/multitask/runs/<run-id>/events.jsonl
.pi/multitask/runs/<run-id>/tasks/<task-id>/state.json
.pi/multitask/runs/<run-id>/tasks/<task-id>/events.jsonl
.pi/multitask/runs/<run-id>/tasks/<task-id>/transcript.jsonl
.pi/multitask/runs/<run-id>/tasks/<task-id>/session/
```

Worker and integration branches use:

```text
mt/<run-id>/<task-id>
mt/<run-id>/integration
```

Worktrees default to the configured `.pi/multitask/config.json` worktree root or a safe derived location outside the foreground checkout.

## Safe operating model and trust boundaries

- **Main chat is the supervisor.** Workers receive task prompts and worker tools, not the multitask orchestration tools by default.
- **Project-local agents are not silently trusted.** Bundled/user agents can be listed with `/mt-agents`; project agents require approval/opt-in and cannot silently escalate sensitive runtime controls.
- **Project config can define named scripts, not arbitrary invisible behavior.** Startup/validation scripts are selected explicitly per run/task and shown to the user before execution.
- **Worktree isolation fails closed.** If worker branch/worktree creation fails, Pi Multitask reports the failure instead of running the worker in the foreground checkout.
- **Review is gated.** Deterministic review is the no-credit baseline. AI review is optional and should be described as credit-consuming before use.
- **Merge/apply is two-step.** `multitask_merge` integrates task branches into the integration worktree; `multitask_apply` requires explicit approval and a clean foreground checkout by default.
- **Cleanup is preview-first.** Use `/mt-cleanup --dry-run` or `/mt-prune` without `--delete` before removing worktrees or run state.
- **Recovery is explicit.** Lost in-memory worker handles are surfaced in status/doctor output; `/mt-resume` or `/mt-send --restart` restarts from persisted session directories when supported.

## How Pi Multitask differs from other packages

| Package | Best for | Pi Multitask difference |
| --- | --- | --- |
| `pi-subagents` | General subagent delegation, parallel/chain tasks, broad agent discovery. | Pi Multitask is not a generic delegation surface. It focuses on repo-local worktrees, persistent addressable workers, deterministic review, integration branches, and explicit apply. |
| Taskplane | Structured batch workflow planning with DAGs, waves, roles, and checkpoints. | Pi Multitask borrows dependency scheduling but keeps Pi as the live supervisor and uses local git worktrees/branches as the integration substrate. |
| `pi-crew` | Durable team/workflow management with dashboards, resources, import/export, and ops tooling. | Pi Multitask keeps the footprint smaller and repo-native: run state lives under `.pi/multitask`, worker outputs are git branches, and foreground changes require explicit approval. |

Choose Pi Multitask when you want multiple local implementation workers without giving up git-native review and merge control.

## Troubleshooting

### The daemon looks stale or status is degraded

Run:

```text
/mt-doctor [run-id]
/mt-status [run-id]
```

Doctor checks Pi RPC availability, stale `daemon.pid`/`daemon.sock`, git state, worktree roots, configured scripts, permissions, and stale worker attachment state. If a worker is detached and restartable, use `/mt-resume` or `/mt-send --restart`.

### A worker did not start

Check for:

- dirty or invalid git state;
- branch/worktree creation errors;
- missing configured script ids;
- `maxConcurrency` queueing;
- unmet dependencies;
- project-local agent trust approval requirements.

Pi Multitask should fail closed rather than run an isolated task in the foreground checkout.

### Apply was refused

`multitask_apply` requires explicit approval and, by default, a clean foreground checkout. Commit/stash/revert local changes or intentionally call the tool with `requireClean: false` only after understanding the risk.

### Cleanup found destructive targets

Run dry-runs first and inspect the listed paths:

```text
/mt-cleanup <run-id> --dry-run
/mt-prune --all
```

Only use `--delete` or omit `--dry-run` after confirming the worktrees/state are no longer needed.

## Testing and package validation

From the repository root:

```bash
npm run test:multitask-no-credit
npm run test:orchestrator-smoke
npm run pack:orchestrator-dry-run
```

The no-credit suite does not spawn LLM-backed workers and does not consume API credits. The smoke suite uses mock workers and temporary git repositories/worktrees.

Real Pi worker E2E is intentionally opt-in because it may consume credits and spawns real `pi --mode rpc` workers:

```bash
PI_MULTITASK_REAL_E2E=1 npm run test:multitask-real
```

See [`docs/release-checklist.md`](docs/release-checklist.md) for the full marketplace release checklist, including install/update/remove verification.

## Package gallery

`package.json` includes the `pi-package` keyword and `pi.image` metadata for the Pi package gallery. The preview asset lives at [`assets/pi-multitask-gallery.png`](assets/pi-multitask-gallery.png). If the repository or publish path changes, update the raw image URL before publishing.

## Included package files

The npm package is constrained with a `files` allowlist. A package dry-run should include only:

- `package.json`
- `README.md`
- `extensions/`
- `src/`
- `prompts/`
- `agents/`
- `docs/`
- `assets/pi-multitask-gallery.png`

Run `npm run pack:dry-run` from `pi-orchestrator/` or `npm run pack:orchestrator-dry-run` from the repository root to verify.
