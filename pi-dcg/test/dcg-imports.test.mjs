// Regression test for the "extension imports a stale/renamed pi package" bug:
//
// `dcg.ts` used to `import ... from "@mariozechner/pi-coding-agent"` — the package's name
// before it was rebranded to `@earendil-works/pi-coding-agent`. That import throws
// `Cannot find package` when pi's jiti-based extension loader resolves it, so the extension
// silently failed to load: no error surfaced anywhere, `pi --list-models` and other no-op
// commands exited 0 as usual, and bash tool calls simply ran with no DCG interception at all.
//
// Rather than hardcoding "@earendil-works/pi-coding-agent" (which would just bake today's
// name into the test and go stale exactly the same way on the next rebrand), this discovers
// the *actual* installed package name from the `pi` binary itself, then asserts the extension
// source only ever references that name.

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const pkgDir = dirname(testDir);
const extensionFile = join(pkgDir, "extensions", "dcg.ts");
const protocolFile = join(pkgDir, "extensions", "lib", "dcg-protocol.mjs");
const packageJsonFile = join(pkgDir, "package.json");

/** Find the nearest ancestor `package.json` starting from `fromDir`, walking up. */
function findNearestPackageJson(fromDir) {
  for (let dir = fromDir; ; ) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function discoverInstalledPiCodingAgentPackageName() {
  const piBinPath = execSync("command -v pi", { encoding: "utf8", shell: "/bin/bash" }).trim();
  const resolvedBinPath = realpathSync(piBinPath);
  const packageJsonPath = findNearestPackageJson(dirname(resolvedBinPath));
  assert.ok(packageJsonPath, `could not find a package.json above the resolved pi binary at ${resolvedBinPath}`);
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  assert.ok(pkg.name, `package.json at ${packageJsonPath} has no "name" field`);
  return pkg.name;
}

const PI_CODING_AGENT_PACKAGE_SHAPE = /@[\w-]+\/pi-coding-agent/g;

test("dcg.ts imports the currently-installed pi-coding-agent package name, not a stale one", () => {
  const installedName = discoverInstalledPiCodingAgentPackageName();
  const source = readFileSync(extensionFile, "utf8");

  const referenced = new Set(source.match(PI_CODING_AGENT_PACKAGE_SHAPE) ?? []);
  assert.ok(referenced.size > 0, "expected dcg.ts to import from a pi-coding-agent package at all");
  assert.deepEqual(
    [...referenced],
    [installedName],
    `dcg.ts references ${[...referenced].join(", ")} but the installed package is ${installedName}. ` +
      "If pi was rebranded, update the import; if this is a real second package, adjust this assertion.",
  );
});

test("dcg-protocol.mjs has no pi-coding-agent dependency (stays loadable without pi/jiti)", () => {
  const source = readFileSync(protocolFile, "utf8");
  assert.doesNotMatch(
    source,
    PI_CODING_AGENT_PACKAGE_SHAPE,
    "dcg-protocol.mjs must stay pi-API-free so it can be unit tested with plain Node",
  );
});

test("package.json peerDependencies matches the currently-installed pi-coding-agent package name", () => {
  const installedName = discoverInstalledPiCodingAgentPackageName();
  const pkg = JSON.parse(readFileSync(packageJsonFile, "utf8"));
  assert.ok(pkg.peerDependencies?.[installedName], `expected package.json peerDependencies to declare "${installedName}"`);
});
