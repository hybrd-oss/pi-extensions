const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { runCommand } = require("../src/utils.js");
const {
  MockWorkerRunner,
  branchExists,
  cleanupRun,
  dispatch,
  getStatus,
  mergeRun,
  verifyRun,
} = require("../src/index.js");

async function execOk(cwd, command, args) {
  const result = await runCommand(command, args, { cwd, timeoutSeconds: 30 });
  assert.equal(result.exitCode, 0, `${command} ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

async function writeFileEnsured(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}

test("multitask smoke: mock workers, worktrees, hooks, integration merge, verify, cleanup", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-multitask-smoke-"));
  const repo = path.join(tempRoot, "repo");
  const runId = "2026-05-23-smoke";

  try {
    await fs.mkdir(repo, { recursive: true });
    await execOk(repo, "git", ["init"]);
    await execOk(repo, "git", ["config", "user.email", "multitask@example.test"]);
    await execOk(repo, "git", ["config", "user.name", "Multitask Test"]);

    await writeFileEnsured(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }, null, 2));
    await writeFileEnsured(path.join(repo, "src", "math.ts"), "export const zero = 0;\n");
    await writeFileEnsured(path.join(repo, "specs", "add-subtract.md"), "# Add/Subtract\n\nAdd add.ts, subtract.ts, and tests.\n");

    const hookCommand = [
      "node -e",
      JSON.stringify(
        "const fs=require('fs');const path=require('path');fs.mkdirSync(process.env.PI_MULTITASK_RUN_DIR,{recursive:true});fs.appendFileSync(path.join(process.env.PI_MULTITASK_RUN_DIR,'hooks.log'),process.env.PI_MULTITASK_WORKTREE_TYPE+'\\n');",
      ),
    ].join(" ");

    await writeFileEnsured(
      path.join(repo, ".pi", "multitask", "config.json"),
      JSON.stringify(
        {
          worktrees: {
            root: "../repo-multitask-worktrees",
          },
          scripts: {
            "record:startup": {
              description: "Record that startup ran",
              command: hookCommand,
              timeoutSeconds: 10,
              required: true,
            },
            "worker:inside-git": {
              command: "git rev-parse --is-inside-work-tree",
              timeoutSeconds: 10,
            },
            "integration:files": {
              command: "test -f src/add.ts && test -f src/subtract.ts && test -f test/math.test.ts",
              timeoutSeconds: 10,
            },
          },
        },
        null,
        2,
      ),
    );

    await execOk(repo, "git", ["add", "."]);
    await execOk(repo, "git", ["commit", "-m", "initial fixture"]);

    const dispatchResult = await dispatch(
      {
        runName: "smoke",
        runId,
        worktreeMode: "per-task",
        tasks: [
          {
            id: "add",
            task: "Implement add.ts",
            startupScripts: ["record:startup"],
            validationScripts: ["worker:inside-git"],
            mockChanges: [{ path: "src/add.ts", content: "export function add(a: number, b: number) { return a + b; }\n" }],
          },
          {
            id: "subtract",
            task: "Implement subtract.ts",
            startupScripts: ["record:startup"],
            validationScripts: ["worker:inside-git"],
            mockChanges: [
              { path: "src/subtract.ts", content: "export function subtract(a: number, b: number) { return a - b; }\n" },
            ],
          },
          {
            id: "tests",
            task: "Add math tests",
            startupScripts: ["record:startup"],
            validationScripts: ["worker:inside-git"],
            mockChanges: [{ path: "test/math.test.ts", content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('math', () => assert.equal(1 + 1, 2));\n" }],
          },
        ],
        integration: {
          startupScripts: ["record:startup"],
          validationScripts: ["integration:files"],
        },
      },
      { cwd: repo, runner: new MockWorkerRunner() },
    );

    assert.equal(dispatchResult.manifest.status, "completed");
    assert.equal(dispatchResult.manifest.tasks.length, 3);
    for (const task of dispatchResult.manifest.tasks) {
      assert.equal(task.status, "completed", task.id);
      assert.ok(task.commit, `task ${task.id} should record commit`);
      assert.ok(await branchExists(repo, task.branch), `branch ${task.branch} should exist`);
      await fs.access(task.worktree);
      assert.deepEqual(task.startupScripts, ["record:startup"]);
      assert.deepEqual(task.validationScripts, ["worker:inside-git"]);
      assert.equal(task.startupResults[0].status, "succeeded");
      assert.equal(task.validation[0].status, "succeeded");
    }

    const status = await getStatus({ runId }, { cwd: repo });
    assert.match(status.summary, /Status: completed/);

    const mergeResult = await mergeRun({ runId }, { cwd: repo });
    assert.equal(mergeResult.integration.status, "ready");
    assert.equal(mergeResult.manifest.status, "integrated");
    await fs.access(path.join(mergeResult.integration.worktree, "src", "add.ts"));
    await fs.access(path.join(mergeResult.integration.worktree, "src", "subtract.ts"));
    await fs.access(path.join(mergeResult.integration.worktree, "test", "math.test.ts"));

    const hooksLog = await fs.readFile(path.join(repo, ".pi", "orchestrator", "runs", runId, "hooks.log"), "utf8");
    assert.equal(hooksLog.split("\n").filter(Boolean).sort().join(","), "integration,worker,worker,worker");

    const verify = await verifyRun({ runId, runValidation: true }, { cwd: repo });
    assert.equal(verify.ok, true, JSON.stringify(verify.checks, null, 2));

    const cleanup = await cleanupRun({ runId }, { cwd: repo });
    assert.equal(cleanup.removed.length, 4);
    for (const removed of cleanup.removed) {
      assert.equal(removed.exitCode, 0, `${removed.worktree}: ${removed.stderr}`);
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
