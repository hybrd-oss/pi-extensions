# pi-orchestrator

A Pi extension package for decomposing large implementation requests into worker tasks, running workers in isolated git worktrees, recording run state, and merging results into an integration worktree.

## Tools

- `orchestrator_plan` — persist an approved plan and task list.
- `orchestrator_dispatch` — create worktrees, run startup hooks, dispatch workers, run worker validation, and write a manifest.
- `orchestrator_status` — list runs or show one run.
- `orchestrator_merge` — create an integration worktree and merge completed worker branches.
- `orchestrator_verify` — verify manifests, worktrees, branches, commits, dirty state, and optional validation.
- `orchestrator_cleanup` — remove run worktrees.

## Commands

- `/orchestrate <request>`
- `/orch-status [run-id]`
- `/orch-merge <run-id>`
- `/orch-verify <run-id>`
- `/orch-cleanup <run-id>`

## Config

Create `.pi/orchestrator/config.json` in a project:

```json
{
  "worktrees": {
    "root": "../repo-orch-worktrees"
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

Select scripts explicitly in `orchestrator_dispatch` per task and integration:

```json
{
  "tasks": [
    {
      "id": "frontend-ui",
      "task": "Implement UI changes",
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

By default, per-task dispatch requires a clean git repo so uncommitted planning/spec files are not silently absent from worker worktrees.

## State

Runs are persisted under:

```text
.pi/orchestrator/runs/<run-id>/manifest.json
.pi/orchestrator/runs/<run-id>/plan.md
```

Worker branches use:

```text
orch/<run-id>/<task-id>
orch/<run-id>/integration
```

## Testing

From the repository root:

```bash
npm test
npm run test:orchestrator-smoke
```

Both use mock workers and do not consume LLM/API credits. Real Pi worker E2E testing is intentionally optional.
