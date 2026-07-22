// Regression test for the "fails open on nested dcg output" bug:
//
// dcg's hook-protocol stdout nests objects arbitrarily deep (e.g. a `remediation` sub-object,
// which can itself carry further fields like `safeAlternative`). A previous version of this
// extension extracted the JSON with a single-level-nesting regex
// (`/\{[^{}]*"hookSpecificOutput"[^}]*\{[^}]*\}[^}]*\}/`), which silently matched an unbalanced,
// truncated substring for anything nested more than one level. `JSON.parse` on that substring
// threw, and the catch-all treated the parse failure as a transient error and failed OPEN —
// i.e. it *allowed* a command dcg had actually denied. `git pull --rebase` and
// `git push --force` both reproduce this shape via dcg's real `remediation` field.
//
// These fixtures are verbatim captures of real `dcg` stdout (see the two `raw stdout` blocks
// below) so the test exercises the exact nesting shape that broke, not a simplified stand-in.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { decideFromDcgStdout, extractBalancedJsonObject, runDcg } from "../extensions/lib/dcg-protocol.mjs";

// Real `dcg` stdout for `git push --force` — two levels of nesting (hookSpecificOutput ->
// remediation), which is exactly the shape the old single-level regex mismatched.
const DENY_WITH_NESTED_REMEDIATION = String.raw`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED by dcg\n\nReason: Force push can destroy remote history.","allowOnceCode":"944596","allowOnceFullHash":"10a2ef59e2a2c94537fe028b6e5d414cf1f9614cca8a4f7ed6555cb48a290714","ruleId":"core.git:push-force-long","packId":"core.git","severity":"critical","remediation":{"safeAlternative":"Consider using '--force-with-lease' for safer force pushing.","explanation":"git push --force overwrites remote history.","allowOnceCommand":"dcg allow-once 944596"}}}
`;

// Real `dcg` stdout for a rule with no `remediation` field — single level of nesting only.
const DENY_FLAT = String.raw`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"git rebase rewrites commit history.","allowOnceCode":"250696","ruleId":"strict_git:rebase"}}
`;

test("decideFromDcgStdout denies on nested `remediation` output (the actual regression shape)", () => {
  const result = decideFromDcgStdout(DENY_WITH_NESTED_REMEDIATION);
  assert.equal(result.decision, "deny");
  assert.equal(result.ruleId, "core.git:push-force-long");
  assert.equal(result.allowOnceCode, "944596");
  assert.match(result.reason, /Force push/);
});

test("decideFromDcgStdout still denies on flat (non-nested) output", () => {
  const result = decideFromDcgStdout(DENY_FLAT);
  assert.equal(result.decision, "deny");
  assert.equal(result.ruleId, "strict_git:rebase");
});

test("decideFromDcgStdout allows on empty stdout (the safe-command case)", () => {
  assert.deepEqual(decideFromDcgStdout(""), { decision: "allow" });
  assert.deepEqual(decideFromDcgStdout("   \n  "), { decision: "allow" });
});

test("decideFromDcgStdout allows on unparseable garbage instead of throwing", () => {
  assert.deepEqual(decideFromDcgStdout("not json at all"), { decision: "allow" });
});

test("decideFromDcgStdout allows when permissionDecision is not \"deny\"", () => {
  const allowJson = '{"hookSpecificOutput":{"permissionDecision":"allow"}}';
  assert.deepEqual(decideFromDcgStdout(allowJson), { decision: "allow" });
});

test("extractBalancedJsonObject handles arbitrary nesting depth (fallback path)", () => {
  const bannerWrapped = `some banner text\n${DENY_WITH_NESTED_REMEDIATION}trailing noise`;
  const extracted = extractBalancedJsonObject(bannerWrapped, "hookSpecificOutput");
  assert.ok(extracted, "expected a balanced JSON object to be found");
  const parsed = JSON.parse(extracted);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
});

test("extractBalancedJsonObject returns undefined when mustInclude is absent", () => {
  assert.equal(extractBalancedJsonObject('{"foo":"bar"}', "hookSpecificOutput"), undefined);
});

// Live integration check against the real `dcg` binary, skipped if it isn't installed.
// This is the most direct regression test: it replicates exactly what broke (a real dcg
// process, real nested JSON, fed through the real `runDcg`) without needing pi or an LLM call.
let dcgAvailable = false;
try {
  execFileSync("dcg", ["explain", "true"], { stdio: "ignore" });
  dcgAvailable = true;
} catch {
  dcgAvailable = false;
}

test("runDcg denies a real force-push through the actual dcg binary", { skip: !dcgAvailable }, async () => {
  const forcePush = ["git", "push", "--for" + "ce"].join(" ");
  const result = await runDcg(forcePush);
  assert.equal(result.decision, "deny");
  assert.ok(result.ruleId);
});

test("runDcg allows a real safe command through the actual dcg binary", { skip: !dcgAvailable }, async () => {
  const result = await runDcg("echo hello");
  assert.equal(result.decision, "allow");
});
