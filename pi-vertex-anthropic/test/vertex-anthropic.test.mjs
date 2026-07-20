// Smoke test: the extension must actually LOAD and REGISTER its models under
// real pi. This is the regression that bit us — deep pi-ai subpath imports pi
// can't resolve made the extension silently fail while `--list-models` still
// exited 0. Running pi for real is the smallest check that catches it.
//
//   node --test test/*.test.mjs   (from the package dir)

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const ext = join(pkgDir, "extensions", "vertex-anthropic.ts");

const EXPECTED = [
	"claude-sonnet-5@default",
	"claude-opus-4-8@default",
	"claude-sonnet-4-6@default",
	"claude-fable-5@default",
	"claude-haiku-4-5@20251001",
];

test("extension loads and registers all vertex-anthropic models under pi", () => {
	const out = execFileSync("pi", ["-e", ext, "--list-models"], { encoding: "utf8" });
	const lines = out.split("\n").filter((l) => l.startsWith("vertex-anthropic"));
	assert.equal(lines.length, EXPECTED.length, `expected ${EXPECTED.length} vertex-anthropic models, got ${lines.length}`);
	for (const id of EXPECTED) {
		assert.ok(
			lines.some((l) => l.includes(id)),
			`missing model "${id}" — extension likely failed to load/register`,
		);
	}
});
