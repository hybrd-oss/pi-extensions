# Pi Multitask Real Pi Manual Testing Loop

This document describes a repeatable manual test for the `pi-orchestrator` / Pi Multitask extension in a real Pi environment. It is intentionally more involved than a smoke test: the sample repository has enough surface area for workers to inspect code, update tests/docs, and run for more than a few seconds.

> Real Pi workers may consume credits. Run this only in a disposable project.

## Goals

Validate the extension end-to-end in a real Pi session:

- local extension install/load;
- doctor/agent discovery commands;
- `multitask_start` with multiple workers and `maxConcurrency`;
- dependency scheduling;
- mid-run `multitask_spawn`;
- worker steering via `/mt-send`;
- status widget and `/mt-panel` inspection;
- deterministic review;
- merge into integration worktree;
- explicit, clean-checkout-gated apply;
- export/prune/cleanup;
- shell cleanup of the temporary git repository and generated worktrees.

## Safety Rules

- Use a throwaway repo outside `pi-extensions`; this guide uses a sibling directory named `pi-multitask-real-manual`.
- Keep the foreground checkout committed before starting a run.
- Keep worker worktrees outside the sample repo, also inside the disposable sibling directory.
- Do not run `/mt-apply` until after `/mt-review`, `/mt-diff`, and `/mt-merge` look correct.
- Run cleanup commands with a path sanity check before `rm -rf`.

## 1. Install or load the extension

From the `pi-extensions` checkout:

```bash
cd /Users/michaelbattaglia/Documents/pi-extensions
npm run test:multitask-no-credit
npm run test:orchestrator-smoke
npm run pack:orchestrator-dry-run
```

For a persistent local install:

```bash
pi install ./pi-orchestrator
pi list
```

Or for a one-session load only, skip install and later start Pi with:

```bash
pi -e /Users/michaelbattaglia/Documents/pi-extensions/pi-orchestrator
```

## 2. Create the disposable sample project

This creates a moderately sized no-dependency Node project with domain, storage, reporting, CLI, docs, tests, and explicit Pi Multitask validation scripts.

```bash
PARENT_DIR="$(dirname "$PWD")"
export MT_MANUAL_ROOT="$PARENT_DIR/pi-multitask-real-manual"
export MT_PROJECT="$MT_MANUAL_ROOT/taskatlas"
export MT_WORKTREES="$MT_MANUAL_ROOT/worktrees"

case "$MT_MANUAL_ROOT" in
  */pi-multitask-real-manual) ;;
  *) echo "Refusing unexpected root: $MT_MANUAL_ROOT" >&2; exit 1 ;;
esac

rm -rf "$MT_MANUAL_ROOT"
mkdir -p "$MT_PROJECT" "$MT_WORKTREES"
cd "$MT_PROJECT"
git init

git config user.name "Pi Multitask Manual Test"
git config user.email "pi-multitask-manual@example.invalid"

cat > package.json <<'JSON'
{
  "name": "taskatlas-manual-fixture",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test",
    "lint": "node scripts/lint.mjs",
    "validate": "npm run lint && npm test",
    "slow-validate": "node scripts/slow-validate.mjs && npm run validate"
  }
}
JSON

mkdir -p src/domain src/storage src/reporting src/cli test docs scripts .pi/multitask

cat > .gitignore <<'EOF'
# Pi Multitask runtime state. Keep the reviewed config tracked, but ignore
# daemon metadata, sockets, run state, transcripts, and other generated files.
.pi/multitask/**
!.pi/multitask/
!.pi/multitask/config.json
EOF

cat > src/domain/task.js <<'JS'
export const TASK_STATUSES = ["todo", "doing", "blocked", "done"];
export const TASK_PRIORITIES = ["low", "medium", "high"];

export function createTask(input) {
  const task = {
    id: String(input.id || "").trim(),
    title: String(input.title || "").trim(),
    status: input.status || "todo",
    priority: input.priority || "medium",
    tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
    estimateHours: Number(input.estimateHours ?? 1),
    notes: String(input.notes || "").trim(),
    createdAt: input.createdAt || new Date(0).toISOString(),
    updatedAt: input.updatedAt || new Date(0).toISOString()
  };
  validateTask(task);
  return task;
}

export function validateTask(task) {
  if (!task.id) throw new Error("Task id is required");
  if (!/^[a-z0-9-]+$/.test(task.id)) throw new Error(`Invalid task id: ${task.id}`);
  if (!task.title) throw new Error("Task title is required");
  if (!TASK_STATUSES.includes(task.status)) throw new Error(`Invalid status: ${task.status}`);
  if (!TASK_PRIORITIES.includes(task.priority)) throw new Error(`Invalid priority: ${task.priority}`);
  if (!Number.isFinite(task.estimateHours) || task.estimateHours <= 0) {
    throw new Error("Estimate must be a positive number");
  }
  return true;
}

export function transitionTask(task, nextStatus, now = new Date(0).toISOString()) {
  validateTask(task);
  if (!TASK_STATUSES.includes(nextStatus)) throw new Error(`Invalid status: ${nextStatus}`);
  if (task.status === "done" && nextStatus !== "done") {
    throw new Error("Done tasks cannot be reopened without an explicit reopen flow");
  }
  return { ...task, status: nextStatus, updatedAt: now };
}

export function summarizeTask(task) {
  validateTask(task);
  const tags = task.tags.length ? ` #${task.tags.join(" #")}` : "";
  return `${task.id}: [${task.status}/${task.priority}] ${task.title}${tags}`;
}
JS

cat > src/domain/project.js <<'JS'
import { createTask, validateTask } from "./task.js";

export function createProject(input) {
  const project = {
    id: String(input.id || "").trim(),
    name: String(input.name || "").trim(),
    owner: String(input.owner || "unassigned").trim(),
    tasks: Array.isArray(input.tasks) ? input.tasks.map(createTask) : []
  };
  validateProject(project);
  return project;
}

export function validateProject(project) {
  if (!project.id) throw new Error("Project id is required");
  if (!project.name) throw new Error("Project name is required");
  const seen = new Set();
  for (const task of project.tasks) {
    validateTask(task);
    if (seen.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    seen.add(task.id);
  }
  return true;
}

export function addTask(project, taskInput) {
  validateProject(project);
  const task = createTask(taskInput);
  if (project.tasks.some((existing) => existing.id === task.id)) {
    throw new Error(`Duplicate task id: ${task.id}`);
  }
  return { ...project, tasks: [...project.tasks, task] };
}

export function updateTask(project, taskId, updater) {
  validateProject(project);
  let changed = false;
  const tasks = project.tasks.map((task) => {
    if (task.id !== taskId) return task;
    changed = true;
    const next = updater(task);
    validateTask(next);
    return next;
  });
  if (!changed) throw new Error(`Unknown task: ${taskId}`);
  return { ...project, tasks };
}
JS

cat > src/storage/memory-store.js <<'JS'
import { createProject } from "../domain/project.js";

export class MemoryProjectStore {
  constructor(initialProjects = []) {
    this.projects = new Map();
    for (const project of initialProjects) {
      const normalized = createProject(project);
      this.projects.set(normalized.id, normalized);
    }
  }

  listProjects() {
    return [...this.projects.values()].map((project) => createProject(project));
  }

  getProject(id) {
    const project = this.projects.get(id);
    return project ? createProject(project) : null;
  }

  saveProject(project) {
    const normalized = createProject(project);
    this.projects.set(normalized.id, normalized);
    return normalized;
  }
}
JS

cat > src/reporting/summary.js <<'JS'
import { validateProject } from "../domain/project.js";
import { summarizeTask, TASK_PRIORITIES, TASK_STATUSES } from "../domain/task.js";

export function statusCounts(project) {
  validateProject(project);
  const counts = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0]));
  for (const task of project.tasks) counts[task.status] += 1;
  return counts;
}

export function priorityCounts(project) {
  validateProject(project);
  const counts = Object.fromEntries(TASK_PRIORITIES.map((priority) => [priority, 0]));
  for (const task of project.tasks) counts[task.priority] += 1;
  return counts;
}

export function riskScore(project) {
  validateProject(project);
  return project.tasks.reduce((score, task) => {
    const statusWeight = task.status === "blocked" ? 5 : task.status === "doing" ? 2 : task.status === "todo" ? 1 : 0;
    const priorityWeight = task.priority === "high" ? 3 : task.priority === "medium" ? 2 : 1;
    return score + statusWeight * priorityWeight + task.estimateHours / 4;
  }, 0);
}

export function markdownSummary(project) {
  validateProject(project);
  const statuses = statusCounts(project);
  const priorities = priorityCounts(project);
  const lines = [
    `# ${project.name}`,
    "",
    `Owner: ${project.owner}`,
    `Risk score: ${riskScore(project).toFixed(1)}`,
    "",
    "## Status counts",
    ...Object.entries(statuses).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## Priority counts",
    ...Object.entries(priorities).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## Tasks",
    ...project.tasks.map((task) => `- ${summarizeTask(task)}`)
  ];
  return `${lines.join("\n")}\n`;
}
JS

cat > src/cli/main.js <<'JS'
import { createProject, addTask, updateTask } from "../domain/project.js";
import { transitionTask } from "../domain/task.js";
import { markdownSummary } from "../reporting/summary.js";

export function runCli(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  const command = argv[2] || "help";
  if (command === "help") {
    io.stdout.write("taskatlas commands: sample, summary\n");
    return 0;
  }
  if (command === "sample") {
    io.stdout.write(JSON.stringify(sampleProject(), null, 2) + "\n");
    return 0;
  }
  if (command === "summary") {
    io.stdout.write(markdownSummary(sampleProject()));
    return 0;
  }
  io.stderr.write(`Unknown command: ${command}\n`);
  return 1;
}

export function sampleProject() {
  let project = createProject({ id: "launch", name: "Launch Plan", owner: "ops" });
  project = addTask(project, {
    id: "scope-api",
    title: "Scope API requirements",
    status: "done",
    priority: "high",
    tags: ["api", "planning"],
    estimateHours: 3
  });
  project = addTask(project, {
    id: "write-docs",
    title: "Write operator docs",
    status: "doing",
    priority: "medium",
    tags: ["docs"],
    estimateHours: 5
  });
  project = addTask(project, {
    id: "load-test",
    title: "Run load test",
    status: "blocked",
    priority: "high",
    tags: ["perf"],
    estimateHours: 8
  });
  project = updateTask(project, "write-docs", (task) => transitionTask(task, "doing"));
  return project;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = runCli(process.argv);
}
JS

cat > test/domain.test.js <<'JS'
import test from "node:test";
import assert from "node:assert/strict";
import { createTask, transitionTask, summarizeTask } from "../src/domain/task.js";
import { createProject, addTask, updateTask } from "../src/domain/project.js";

test("task validation and summary", () => {
  const task = createTask({ id: "write-tests", title: "Write tests", priority: "high", tags: ["qa"], estimateHours: 2 });
  assert.equal(task.status, "todo");
  assert.match(summarizeTask(task), /write-tests/);
  assert.throws(() => createTask({ id: "Bad Id", title: "Nope" }), /Invalid task id/);
});

test("project task lifecycle", () => {
  let project = createProject({ id: "manual", name: "Manual Test" });
  project = addTask(project, { id: "first-task", title: "First task" });
  project = updateTask(project, "first-task", (task) => transitionTask(task, "doing"));
  assert.equal(project.tasks[0].status, "doing");
  assert.throws(() => addTask(project, { id: "first-task", title: "Duplicate" }), /Duplicate/);
});
JS

cat > test/reporting.test.js <<'JS'
import test from "node:test";
import assert from "node:assert/strict";
import { sampleProject } from "../src/cli/main.js";
import { statusCounts, priorityCounts, riskScore, markdownSummary } from "../src/reporting/summary.js";

test("reporting counts and markdown", () => {
  const project = sampleProject();
  assert.deepEqual(statusCounts(project), { todo: 0, doing: 1, blocked: 1, done: 1 });
  assert.equal(priorityCounts(project).high, 2);
  assert.ok(riskScore(project) > 0);
  assert.match(markdownSummary(project), /# Launch Plan/);
});
JS

cat > scripts/lint.mjs <<'JS'
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const roots = ["src", "test", "scripts"];
const failures = [];
const forbiddenMarker = ["TODO", "_FAIL"].join("");

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    const isScript = entry.isFile() && (path.endsWith(".js") || path.endsWith(".mjs"));
    if (!isScript) continue;
    const text = await readFile(path, "utf8");
    if (text.includes(forbiddenMarker)) failures.push(`${path}: contains forbidden marker`);
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      if (line.length > 140) failures.push(`${path}:${index + 1}: line longer than 140 chars`);
    });
  }
}

for (const root of roots) await walk(root);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("lint ok");
JS

cat > scripts/slow-validate.mjs <<'JS'
// Optional validation hook to make manual observation easier. It is intentionally
// short enough not to waste much time but long enough to see queued/running states.
await new Promise((resolve) => setTimeout(resolve, 15000));
console.log("slow validation delay complete");
JS

cat > docs/architecture.md <<'MD'
# TaskAtlas Architecture

TaskAtlas is a deliberately small project-management library for testing Pi Multitask.

- `src/domain`: task and project validation/lifecycle rules.
- `src/storage`: persistence adapters.
- `src/reporting`: status, priority, risk, and markdown reports.
- `src/cli`: command-line entry points.
- `test`: no-dependency Node test suite.

Known gaps for workers to improve:

1. There is no durable JSON file store.
2. Search/filter behavior is missing.
3. CLI output is minimal and lacks import/export commands.
4. Reporting does not expose blocked-task detail or due-date risk.
5. Documentation needs examples for operators.
MD

cat > README.md <<'MD'
# TaskAtlas Manual Fixture

A disposable project used to manually test Pi Multitask with real workers.

Run validation:

```bash
npm run validate
```

Generate a sample summary:

```bash
node src/cli/main.js summary
```
MD

cat > .pi/multitask/config.json <<JSON
{
  "worktrees": {
    "root": "$MT_WORKTREES"
  },
  "scripts": {
    "validate": {
      "command": "npm run validate",
      "cwd": ".",
      "timeoutSeconds": 120
    },
    "slow-validate": {
      "command": "npm run slow-validate",
      "cwd": ".",
      "timeoutSeconds": 180
    }
  },
  "defaults": {
    "workerStartupScripts": [],
    "workerValidationScripts": ["validate"],
    "integrationStartupScripts": [],
    "integrationValidationScripts": ["slow-validate"]
  },
  "review": {
    "mode": "deterministic",
    "requireDeterministicPass": true
  }
}
JSON

npm run validate
git add .
git commit -m "initial manual fixture"
```

The baseline repo should now be clean:

```bash
git status --short
```

## 3. Start Pi in the sample repo

If installed persistently:

```bash
cd "$MT_PROJECT"
pi
```

If using one-session extension loading:

```bash
cd "$MT_PROJECT"
pi -e /Users/michaelbattaglia/Documents/pi-extensions/pi-orchestrator
```

Inside Pi, run:

```text
/mt-doctor
/mt-agents
/mt-status
/mt-panel
```

Expected:

- doctor reports the repo/config/worktree setup clearly;
- bundled agents are listed;
- status handles the no-run state;
- panel opens without dumping transcripts into chat context.

## 4. Start a real multitask run

Paste this prompt into Pi:

```text
Use Pi Multitask to run a real manual test in this disposable TaskAtlas repo.

Create a run named taskatlas-real-manual with maxConcurrency 2. Before starting, inspect the project enough to understand the architecture and then propose the worker plan for approval.

Use these workers:

1. id: json-store
   agent: worker
   goal: Add a durable JSON file project store under src/storage/json-store.js. It should load/save arrays of projects, preserve domain validation, handle missing files gracefully, create parent directories as needed, and include focused tests.
   validationScripts: ["validate"]

2. id: search-and-risk
   agent: worker
   goal: Add search/filter utilities for projects and tasks. Include filters for status, priority, tag, owner, free-text query, and blocked/high-risk tasks. Extend reporting to expose blocked task details and due-date or estimate based risk notes. Include tests.
   validationScripts: ["validate"]

3. id: cli-import-export
   agent: worker
   goal: Expand the CLI with commands for summary, export-json, import-json, and search. Keep it no-dependency and testable by injecting IO. Update README examples and tests.
   validationScripts: ["validate"]

4. id: docs-operator-guide
   agent: worker
   goal: Write docs/operator-guide.md with realistic operator workflows, examples, and troubleshooting. Update README to point to it. Keep docs consistent with the implemented CLI and storage behavior.
   validationScripts: ["validate"]

Dependencies:
- json-store must finish before cli-import-export.
- search-and-risk must finish before cli-import-export.
- cli-import-export must finish before docs-operator-guide.

Use the configured validation scripts. Do not apply anything to my foreground checkout until I explicitly approve.
```

Expected during the run:

- only two tasks should run at once because `maxConcurrency` is 2;
- dependent tasks should remain queued/blocked until prerequisites are ready;
- worker worktrees should appear under `$MT_WORKTREES`;
- the integration validation should use the slower script, making merge/apply observation easier.

Observe progress:

```text
/mt-status
/mt-panel
```

In another shell, optional inspection:

```bash
find "$MT_WORKTREES" -maxdepth 2 -type d | sort
git worktree list
```

## 5. Exercise steering, spawn, and attention flows

After at least one worker starts, send steering to a running worker:

```text
/mt-send <run-id> json-store Please include corrupt JSON handling and document the behavior in the tests.
```

Spawn an extra task mid-run:

```text
Spawn a new task into run <run-id>:
- id: validation-hardening
- agent: worker
- goal: Review validation coverage across task/project/reporting/CLI behavior. Add missing edge-case tests without changing public behavior unless a bug is clearly found.
- validationScripts: ["validate"]
It may run independently when capacity is available.
```

Then inspect again:

```text
/mt-status <run-id>
/mt-panel
```

Expected:

- the spawned task is appended to the run;
- queued/running/attention/ready counts remain stable and understandable;
- transcript tail views show bounded tails, not full logs.

## 6. Review, merge, export, and apply

When tasks are ready:

```text
/mt-review <run-id>
/mt-diff <run-id>
/mt-merge <run-id>
/mt-export <run-id> ../export-<run-id>
```

Expected:

- deterministic review runs without optional AI review unless explicitly configured;
- merge brings task branches into the integration worktree;
- integration validation output is visible and actionable;
- export contains manifest, plan/events, transcripts, diffs, reviews, and integration metadata.

Before apply, verify dirty-checkout protection:

```bash
cd "$MT_PROJECT"
echo "temporary dirty line" >> README.md
git status --short
```

In Pi:

```text
/mt-apply <run-id>
```

Expected: apply refuses because the foreground checkout is dirty.

Clean the intentional dirty change:

```bash
cd "$MT_PROJECT"
git checkout -- README.md
git status --short
```

Then apply only if you want to validate the full foreground integration path:

```text
/mt-apply <run-id>
```

Expected:

- Pi asks for or requires explicit approval;
- changes are applied to the foreground checkout only after approval;
- `npm run validate` still passes.

After apply:

```bash
cd "$MT_PROJECT"
npm run validate
git status --short
git diff --stat
git add .
git commit -m "manual multitask applied result"
```

## 7. Optional recovery test

Start or keep a run with at least one active/restartable task. Quit Pi, then restart it in the same repo:

```bash
cd "$MT_PROJECT"
pi
```

Inside Pi:

```text
/mt-status <run-id>
/mt-doctor <run-id>
/mt-resume <run-id> <task-id> Please continue from the persisted session state and summarize current progress.
```

Expected:

- stale/lost/detached workers are classified;
- status and doctor provide recovery suggestions;
- restartable workers can be resumed from persisted session directories where feasible.

## 8. Cleanup from inside Pi

First preview destructive cleanup:

```text
/mt-prune <run-id>
/mt-cleanup <run-id> --dry-run
```

If the preview is correct, run the confirmed cleanup path exposed by the extension, for example:

```text
/mt-prune <run-id> --delete
```

or:

```text
/mt-cleanup <run-id> --state
```

Expected:

- cleanup previews before deleting;
- worker worktrees are removed;
- run state is removed only when explicitly requested;
- `git worktree list` no longer shows stale TaskAtlas worker worktrees.

## 9. Shell cleanup of generated project files

Exit Pi first. Then run:

```bash
cd /tmp

# Sanity checks before deleting anything.
test -n "$MT_MANUAL_ROOT"
case "$MT_MANUAL_ROOT" in
  */pi-multitask-real-manual) echo "cleanup root ok: $MT_MANUAL_ROOT" ;;
  *) echo "Refusing to delete unexpected path: $MT_MANUAL_ROOT" >&2; exit 1 ;;
esac

# Best-effort git cleanup before removing directories.
if [ -d "$MT_PROJECT/.git" ]; then
  git -C "$MT_PROJECT" worktree prune || true
  git -C "$MT_PROJECT" worktree list || true
fi

rm -rf "$MT_MANUAL_ROOT"
```

If you installed the extension persistently for this test and want to remove it:

```bash
pi remove /Users/michaelbattaglia/Documents/pi-extensions/pi-orchestrator
pi list
```

## Manual Acceptance Checklist

Before considering the real-environment test successful, verify:

- [ ] Baseline sample project validates before Pi starts.
- [ ] `/mt-doctor` explains repo/config/worktree status.
- [ ] `/mt-agents` lists bundled roles.
- [ ] `maxConcurrency: 2` is respected.
- [ ] Dependencies delay downstream tasks.
- [ ] `/mt-send` reaches a worker.
- [ ] Mid-run spawn appends and schedules a task.
- [ ] `/mt-panel` renders board/detail/transcript/diff/review/integration views.
- [ ] Deterministic review completes.
- [ ] Merge runs integration validation and reports output.
- [ ] Apply refuses a dirty foreground checkout.
- [ ] Apply requires explicit approval.
- [ ] Export works without live worker interaction.
- [ ] Prune/cleanup previews before deletion.
- [ ] Final shell cleanup removes the temporary repo/worktrees/export directory.
