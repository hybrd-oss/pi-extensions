# Porchestrator Dashboard Spec

## Purpose

Porchestrator should have an optional local web dashboard that makes long-running multitask runs easier to supervise than the in-chat TUI alone. The dashboard is a second-layer UX over the existing Pi Multitask daemon/client/state model; it must not replace the command/tool safety gates.

Primary goals:

- show all active and historical runs in one place;
- make queued/running/attention/ready/merged task state visually obvious;
- inspect task detail, transcript tails, diffs, reviews, and integration status without dumping full logs into model context;
- send safe steering/follow-up messages to workers;
- expose review/merge/export/prune/apply flows with the same or stricter safety confirmations as the CLI/TUI;
- remain local-only, no-credit by default, and safe for disposable and real repos.

Non-goals for the first version:

- public/LAN dashboard hosting;
- cloud sync;
- generic subagent dashboard unrelated to Porchestrator runs;
- replacing `/mt-*` commands;
- native macOS app implementation, though the web dashboard should be easy to wrap later.

## Product Positioning

The dashboard is the visual control room for Porchestrator:

> Porchestrator runs local Pi workers in isolated git worktrees. The dashboard lets the user watch, inspect, steer, review, and safely integrate those workers without losing the main Pi chat as supervisor.

Keep the underlying technical names stable for compatibility:

- commands remain `/mt-*`;
- tools remain `multitask_*`;
- state remains `.pi/multitask`;
- manifests/events keep existing field names.

Display copy may use `Porchestrator` and describe the engine as “Pi Multitask mode”.

## User Stories

### 1. Open dashboard from Pi

As a user running Pi in a repo, I can run:

```text
/mt-dashboard
```

Expected behavior:

- starts or reuses a local dashboard server bound to `127.0.0.1`;
- prints and optionally opens a browser URL;
- includes a per-session auth token in the URL;
- defaults to the active run if one exists;
- works even when no run exists, showing doctor/config readiness.

Example output:

```text
Porchestrator dashboard running:
http://127.0.0.1:47391/?token=<redacted>

Bound to localhost only. Keep this URL private.
```

### 2. Monitor a long-running run

As workers run, I can see:

- active run name/id;
- base branch/commit;
- integration branch/worktree;
- worktree root;
- `maxConcurrency`;
- counts for queued/running/attention/ready/merged/failed;
- live task board updates;
- daemon/recovery warnings.

### 3. Inspect a worker safely

Selecting a task shows:

- assignment prompt;
- agent/model metadata when available;
- status and recovery classification;
- branch/worktree/session directory;
- dependency information;
- event timeline;
- transcript tail with bounded entries;
- changed files;
- diff summary;
- review findings;
- validation output.

The dashboard must never auto-load unbounded transcript or diff content. Large content needs explicit “load more” or file-specific requests.

### 4. Steer a worker

From a task detail page, I can send:

- follow-up message;
- steer message;
- typed decision;
- review feedback.

The dashboard should use existing `multitask_message` semantics and preserve simple string compatibility.

### 5. Handle attention states

If a worker needs a decision, the dashboard highlights the task in an attention column/card and shows:

- reason;
- summary;
- correlation id if available;
- suggested next actions.

A decision form sends a typed `decision` message back to the worker.

### 6. Review and merge

When tasks are ready, I can:

- run deterministic review for selected tasks or all ready tasks;
- inspect review results;
- see optional AI review clearly marked as credit-consuming if enabled;
- merge selected ready tasks into the integration worktree;
- inspect integration validation output.

### 7. Apply safely

Apply remains dangerous and must be gated.

The dashboard can expose an Apply button only after:

- integration status is ready;
- foreground checkout cleanliness check passes;
- user sees a changed-file/diff summary;
- user types an explicit confirmation phrase such as `apply <run-id>`.

The server-side apply path must still enforce approval and clean-checkout requirements. UI checks are advisory only.

### 8. Export, prune, and cleanup

The dashboard can:

- export run evidence;
- preview prune/cleanup targets;
- show exact paths that would be removed;
- require explicit confirmation before deleting worktrees or state.

## UX Structure

### Top Navigation

- Runs
- Active Run
- Doctor
- Agents
- Settings/Config

### Run List View

Shows all known runs:

- run name/id;
- status;
- created/updated time;
- task counts;
- integration status;
- warning badges;
- quick actions: open, export, cleanup preview.

### Run Detail View

Sections:

1. Header
   - display name and run id;
   - status;
   - base branch/commit;
   - integration branch/worktree;
   - max concurrency;
   - daemon/recovery status.

2. Task Board
   - columns: queued, blocked, running, needs attention, ready for review, needs changes, ready to merge, merged, failed/aborted;
   - card badges for agent, validation, review, changed files, dependency blockers.

3. Timeline
   - recent run-level events;
   - filters for task id and event type.

4. Integration
   - integration worktree/branch;
   - merge status;
   - validation status/output tail;
   - apply readiness.

### Task Detail Drawer/Page

Tabs:

- Overview
- Transcript Tail
- Diff
- Review
- Validation
- Events
- Recovery

### Doctor View

Displays checks from existing doctor helpers:

- Pi RPC availability;
- git repo/worktree state;
- daemon socket/pid health;
- stale pid/socket files;
- worktree root permissions;
- script/config validity;
- foreground checkout cleanliness;
- persisted worker recovery state.

Each warning/failure should include recovery instructions.

### Agents View

Displays agent registry results:

- name;
- source/provenance: bundled, user, project, legacy;
- trust status;
- model/thinking/tools summary;
- whether project-local controls were restricted.

No project-local agent should become trusted purely by being viewed in the dashboard.

## API Design

The dashboard server should be a thin local HTTP layer over existing multitask client/daemon helpers.

Suggested modules:

```text
pi-orchestrator/src/multitask/dashboard-server.js
pi-orchestrator/src/multitask/dashboard-api.js
pi-orchestrator/src/multitask/dashboard-auth.js
pi-orchestrator/dashboard/                # static UI assets or build output
```

Suggested extension command wiring:

```text
/mt-dashboard [run-id]
/mt-dashboard stop
/mt-dashboard status
```

### Server Lifecycle

- Bind to `127.0.0.1` by default.
- Select an available port, default range `47391-47420`.
- Generate a random session token at startup.
- Reuse an existing dashboard server for the same repo when healthy.
- Stop on Pi session shutdown unless explicitly configured otherwise.
- Expose dashboard health in `/mt-doctor`.

### Authentication

Every API request must require one of:

- bearer token header; or
- token query param for browser navigation followed by same-origin session storage/cookie.

Token requirements:

- random enough for local protection;
- never logged in full by default;
- reset on dashboard restart.

### Local-Only Network Policy

Default:

```text
host: 127.0.0.1
```

Non-goals:

- no `0.0.0.0` binding in initial version;
- no remote access;
- no CORS wildcard.

If LAN support is ever added, it must require explicit config and stronger auth.

## Suggested Endpoints

Read-only:

```text
GET /health
GET /api/status
GET /api/runs
GET /api/runs/:runId
GET /api/runs/:runId/events?limit=100&cursor=...
GET /api/runs/:runId/tasks/:taskId
GET /api/runs/:runId/tasks/:taskId/transcript?limit=100&cursor=...
GET /api/runs/:runId/tasks/:taskId/diff?maxFiles=50
GET /api/runs/:runId/review
GET /api/runs/:runId/integration
GET /api/doctor?runId=...
GET /api/agents
GET /api/config
GET /api/events/stream
```

Actions:

```text
POST /api/runs/:runId/tasks/:taskId/message
POST /api/runs/:runId/tasks/:taskId/resume
POST /api/runs/:runId/tasks/:taskId/abort
POST /api/runs/:runId/review
POST /api/runs/:runId/merge
POST /api/runs/:runId/apply
POST /api/runs/:runId/export
POST /api/prune/preview
POST /api/prune/confirm
POST /api/dashboard/stop
```

### Event Streaming

Use Server-Sent Events for the first version:

```text
GET /api/events/stream
```

SSE event types:

- `status`;
- `run_event`;
- `task_event`;
- `attention`;
- `review`;
- `merge`;
- `validation`;
- `recovery`;
- `doctor`;
- `error`.

SSE is enough for live updates and simpler than WebSockets. If bidirectional real-time behavior is needed later, add WebSockets after the API is stable.

## API Payload Principles

Reuse stable status DTOs from the multitask contracts module wherever possible.

All endpoints should return bounded, display-oriented data by default:

- transcript tail limit defaults to 100 entries or less;
- diff endpoint defaults to file summaries and bounded patches;
- validation/review output is truncated with explicit continuation metadata;
- full export is available through `/api/runs/:runId/export`, not implicit page loads.

Example task detail response:

```json
{
  "runId": "run-123",
  "taskId": "json-store",
  "status": "running",
  "attachmentState": "attached",
  "agent": "worker",
  "branch": "porchestrator/run-123/json-store",
  "worktree": "/tmp/.../json-store",
  "dependencies": [],
  "assignment": {
    "summary": "Add durable JSON store",
    "promptTail": "..."
  },
  "counts": {
    "events": 12,
    "transcriptEntries": 80,
    "changedFiles": 3
  },
  "lastEvent": {
    "type": "worker_output",
    "createdAt": "2026-05-28T12:00:00.000Z"
  }
}
```

## Action Safety Requirements

### Message/Steer

- Accept simple text and typed envelopes.
- Optional `mode`: `followUp` or `steer`.
- Optional `type`: `assignment`, `question`, `inform`, `review_feedback`, `decision`.
- Optional `restartIfNeeded` only if the user explicitly checks a resume/restart option.

### Resume

- Show recovery classification before resume.
- Only resume states supported by existing recovery policy.
- Show session directory and last known worker state.

### Abort

- Require confirmation.
- Show whether this aborts one task or an entire run.

### Review

- Deterministic review is default and no-credit.
- AI review must be opt-in and visibly marked as credit-consuming.

### Merge

- Only merge ready tasks by default.
- Show selected task branches.
- Show integration worktree path.
- Surface conflicts with recovery instructions.

### Apply

- Require typed confirmation: `apply <run-id>`.
- Server must pass explicit approval to existing apply helper.
- Server must preserve clean foreground checkout requirement by default.
- Never allow UI-only checks to bypass server-side protections.

### Prune/Cleanup

- Preview first.
- Require confirmation phrase for deletion.
- Show exact directories/files targeted.
- Never delete paths outside known run/worktree/state roots.

## Security Model

The dashboard must preserve Porchestrator trust boundaries:

- local-only bind by default;
- random token required for all APIs;
- no wildcard CORS;
- no arbitrary file browsing;
- no arbitrary shell command endpoint;
- no auto-apply;
- no automatic project-local agent trust;
- no worker tool escalation;
- no unisolated worker fallback;
- bounded transcript/diff reads;
- destructive actions require confirmation and server-side validation.

## Implementation Phases

### Phase 0 — Spec and copy alignment

- Decide display name: `Porchestrator`.
- Keep internal protocol/tool/state names as `multitask`.
- Add docs describing dashboard as optional.

### Phase 1 — Read-only local dashboard

Owns:

- dashboard server lifecycle;
- auth token;
- static page serving;
- status/runs/run/task/read-only endpoints;
- bounded transcript and diff endpoints;
- doctor and agents views;
- `/mt-dashboard` open/status/stop command.

Acceptance:

- Can open dashboard with no active run.
- Can render active run from real status DTOs.
- Can render queued/running/attention/ready tasks.
- Can inspect bounded transcript tails and diff summaries.
- Server binds only to localhost and requires token.
- No destructive actions exist yet.
- No-credit tests pass.

### Phase 2 — Live updates

Owns:

- SSE endpoint;
- event cursor/last-event-id support where practical;
- UI auto-refresh on events;
- connection status indicator.

Acceptance:

- Task status changes appear without manual refresh.
- Attention events are highlighted.
- SSE disconnects are visible and retry automatically.

### Phase 3 — Safe actions

Owns:

- message/steer;
- resume/restart;
- deterministic review;
- export;
- doctor rerun.

Acceptance:

- Dashboard can send follow-up messages to workers.
- Dashboard can resume restartable detached workers.
- Review results update UI.
- Export works without live worker credits.
- No destructive actions are available without confirmations.

### Phase 4 — Integration actions

Owns:

- merge selected;
- apply with typed confirmation;
- cleanup/prune preview and confirm.

Acceptance:

- Merge respects ready-task gates.
- Apply refuses dirty foreground checkout by default.
- Apply requires typed confirmation and server-side approval.
- Cleanup preview shows exact targets.
- Confirmed cleanup stays inside known roots.

### Phase 5 — Mac wrapper exploration

After the web dashboard is useful:

- evaluate a thin SwiftUI/WebView wrapper;
- reuse the same localhost dashboard server;
- add repo/run deep links if helpful;
- keep native app optional.

## Testing Strategy

### No-credit unit tests

- token generation and validation;
- localhost binding config;
- endpoint auth middleware;
- DTO serialization/truncation;
- transcript/diff bounds;
- action confirmation validation;
- path safety checks for cleanup;
- dashboard server lifecycle with mocked daemon client.

### Mock integration tests

- start dashboard in temp repo;
- fetch read-only endpoints;
- connect SSE client;
- trigger mock status/event updates;
- send mocked message/review/export actions;
- verify destructive actions require confirmation.

### Manual real Pi tests

Use the disposable TaskAtlas fixture from `specs/pi-multitask-real-manual-testing.md`:

1. Start a real multitask run.
2. Open `/mt-dashboard`.
3. Verify board counts match `/mt-status` and `/mt-panel`.
4. Inspect transcript tail for a running worker.
5. Send a steer message.
6. Spawn a task from Pi and verify dashboard update.
7. Run review/merge/apply flow from CLI/TUI first; dashboard integration actions come in later phases.

## Packaging Notes

Dashboard static assets should be included in the package allowlist once implemented:

```json
{
  "files": [
    "dashboard",
    "src",
    "extensions",
    "prompts",
    "agents",
    "README.md"
  ]
}
```

Avoid large build artifacts or source maps unless needed. If using a frontend build tool, document the build step and ensure `npm pack --dry-run` includes only intended files.

## Open Questions

1. Should `/mt-dashboard` automatically open the browser, or only print the URL unless `--open` is supplied?
2. Should the dashboard server stop on Pi session shutdown, or remain detached for long-running supervision?
3. Should there be one dashboard server per repo, or one global server that can switch repos?
4. Should the UI use vanilla JS/CSS, Preact, or another lightweight frontend stack?
5. Should dashboard actions call the daemon protocol directly or go through the same client wrapper used by extension commands?
6. How much transcript/diff history should be available interactively before requiring explicit export?
7. Should the future Mac wrapper be a first-party package or a separate app/repo?

## Recommended First Slice

Implement Phase 1 only:

- `/mt-dashboard` command;
- localhost server with token;
- static read-only UI;
- run list;
- task board;
- task detail;
- transcript tail;
- diff summary;
- doctor/agents views.

This delivers immediate UX value while avoiding the risk of bypassing existing merge/apply/cleanup safety gates.
