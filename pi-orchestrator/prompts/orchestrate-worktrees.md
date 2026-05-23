Orchestrate this implementation with one git worktree per worker:

$ARGUMENTS

Read the specs first, split into independent workstreams, ask for my approval, then use `orchestrator_dispatch` with `worktreeMode: "per-task"`. Require workers to commit and report validation. Do not merge until I approve integration.
