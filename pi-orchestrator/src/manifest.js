const { ensureDir, fsp, path, pathExists } = require("./utils.js");

function runsRoot(repoRoot) {
  return path.join(repoRoot, ".pi", "orchestrator", "runs");
}

function runDir(repoRoot, runId) {
  return path.join(runsRoot(repoRoot), runId);
}

function manifestPath(repoRoot, runId) {
  return path.join(runDir(repoRoot, runId), "manifest.json");
}

async function saveManifest(repoRoot, manifest) {
  const dir = runDir(repoRoot, manifest.runId);
  await ensureDir(dir);
  manifest.updatedAt = new Date().toISOString();
  await fsp.writeFile(manifestPath(repoRoot, manifest.runId), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return manifest;
}

async function loadManifest(repoRoot, runId) {
  const file = manifestPath(repoRoot, runId);
  if (!(await pathExists(file))) throw new Error(`No orchestrator manifest found for run ${runId} at ${file}`);
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

async function listRuns(repoRoot) {
  const root = runsRoot(repoRoot);
  if (!(await pathExists(root))) return [];
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      runs.push(await loadManifest(repoRoot, entry.name));
    } catch {
      // Ignore malformed run dirs.
    }
  }
  runs.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return runs;
}

async function writePlan(repoRoot, runId, markdown) {
  const dir = runDir(repoRoot, runId);
  await ensureDir(dir);
  await fsp.writeFile(path.join(dir, "plan.md"), markdown, "utf8");
}

module.exports = { listRuns, loadManifest, manifestPath, runDir, runsRoot, saveManifest, writePlan };
