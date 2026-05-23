Use the orchestrator extension for this request:

$ARGUMENTS

Workflow:

1. Read referenced specs and inspect relevant code.
2. Propose a task decomposition with clear file ownership and shared-file risks.
3. Ask me to approve the plan before dispatch.
4. After approval, call `orchestrator_dispatch` with `worktreeMode: "per-task"`.
5. Report worker branches, commits, validation, and notes.
6. Ask before calling `orchestrator_merge`.
