# pi-orchestrator

A Pi extension package for Cursor-like local multitask mode: decompose large requests into persistent Pi worker sessions, run them in isolated git worktrees, message/monitor them while the main chat remains usable, and later review/merge/apply their results.

## Tools

- `multitask_start` — create a multitask run, local worktrees, and persistent worker sessions, then return immediately.
- `multitask_spawn` — add a worker to an existing run. *(Backend placeholder.)*
- `multitask_message` — send a steer/follow-up/prompt message to a worker session.
- `multitask_status` — list runs or show one run, including daemon health.
- `multitask_diff` — show task/integration diffs and changed-file summaries.
- `multitask_review` — run deterministic no-credit review checks and mark tasks ready/needs-changes.
- `multitask_merge` — merge ready tasks into integration.
- `multitask_apply` — apply integration back to the foreground checkout.
- `multitask_cancel` — cancel a worker or whole run.

## Commands

- `/multitask <request>`
- `/mt <request>`
- `/mt-status [run-id]`
- `/mt-send <run-id> <task-id> [message]`
- `/mt-diff <run-id> [task-id]`
- `/mt-review <run-id> [task-id]`
- `/mt-merge <run-id> [task-id...]`
- `/mt-apply <run-id>`
- `/mt-cancel <run-id> [task-id]`
- `/mt-cleanup <run-id> [--state] [--dry-run]`
- `/mt-config [show|validate|init|add-script|set-defaults]`

## Config

Create `.pi/multitask/config.json` in a project:

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
  }
}
```

Select scripts explicitly in `multitask_start` per task and integration:

```json
{
  "tasks": [
    {
      "id": "frontend-ui",
      "prompt": "Implement UI changes",
      "startupScripts": ["frontend:setup"],
      "validationScripts": ["frontend:test"]
    }
  ],
  "integration": {
    "startupScripts": ["frontend:setup", "backend:setup"],
    "validationScripts": ["frontend:test", "backend:test"]
  }
}
```

Do not auto-detect startup or validation scripts; choose named scripts explicitly and show the selections to the user before starting workers.

## State

Runs and daemon state are persisted under:

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

Worker branches use:

```text
mt/<run-id>/<task-id>
mt/<run-id>/integration
```

## Robustness and cleanup

Phase 6 adds defensive daemon lifecycle helpers:

- stale `.pi/multitask/daemon.pid` / `daemon.sock` detection and best-effort cleanup;
- status summaries that include daemon health (`running`, `stale`, `degraded`, or `stopped`);
- process-exit cleanup hooks for daemon socket/pid files;
- worker-session stop hooks that drain persistence before forgetting sessions;
- cleanup helpers for run worktrees/state, exposed through `/mt-cleanup`.

Use `/mt-cleanup <run-id> --dry-run` to preview targets. Omit `--dry-run` to remove selected worktrees. Add `--state` to also remove `.pi/multitask/runs/<run-id>`.

## Testing

From the repository root:

```bash
npm run test:multitask-no-credit
npm test
npm run test:orchestrator-smoke
```

`test:multitask-no-credit` is the Phase 6 unit suite. It does not create git worktrees/branches, does not spawn real Pi workers, and does not consume LLM/API credits. `test:orchestrator-smoke` uses mock workers but creates temporary git worktrees. Real Pi worker E2E testing is intentionally optional via `npm run test:orchestrator-real`.
