# Multitask Review Loop

Use this prompt when a Pi Multitask worker is ready for review.

1. Run deterministic review first. This is mandatory and no-credit.
2. Only enable AI review when the user or run config explicitly requests `mode: "ai"` or `mode: "both"`.
3. Tell the user that AI review is credit-consuming before enabling it.
4. If deterministic checks fail, send the deterministic feedback to the worker and keep the task in `needs_changes`.
5. If AI review finds actionable issues, send a typed `review_feedback` message to the worker, keep the task in `needs_changes`, and ask the worker to report done when ready for another round.
6. Stop after `maxRounds` unless the user explicitly asks for another round.
7. Mark the task `ready_to_merge` only after all required deterministic checks pass and the required AI review round has no actionable findings.
