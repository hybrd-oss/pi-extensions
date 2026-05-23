const test = require("node:test");

// Real Pi worker E2E tests intentionally require an explicit environment variable
// because they spawn LLM-backed `pi` workers and may consume API credits.
test("real pi orchestrator e2e is opt-in", { skip: process.env.PI_ORCHESTRATOR_REAL_E2E !== "1" }, async () => {
  // Placeholder for maintainers: create a fixture repo and call dispatch() without a MockWorkerRunner.
  // The mock smoke test covers baseline behavior without API calls.
});
