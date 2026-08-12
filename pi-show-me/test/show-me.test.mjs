import assert from "node:assert/strict";
import test from "node:test";

import showMeExtension from "../extensions/show-me.js";

function createHarness() {
  const events = new Map();
  const commands = new Map();
  const appendedEntries = [];
  const notifications = [];
  const statuses = [];
  const pi = {
    on(name, handler) {
      events.set(name, handler);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    appendEntry(customType, data) {
      appendedEntries.push({ customType, data });
    },
  };

  showMeExtension(pi);
  return {
    events,
    commands,
    appendedEntries,
    ctx: (entries = []) => ({
      sessionManager: { getBranch: () => entries },
      ui: {
        notify: (message, level) => notifications.push({ message, level }),
        setStatus: (key, value) => statuses.push({ key, value }),
      },
    }),
    notifications,
    statuses,
  };
}

test("injects the bundled policy by default", async () => {
  const { events, ctx } = createHarness();
  await events.get("session_start")({}, ctx());

  const result = await events.get("before_agent_start")({ systemPrompt: "BASE" });
  assert.match(result.systemPrompt, /^BASE\n\nSHOW-ME MODE ACTIVE/);
  assert.match(result.systemPrompt, /do not add a visual merely to prove the mode is active/i);
});

test("/show-me enables, disables, and reports status", async () => {
  const { commands, events, appendedEntries, ctx, notifications, statuses } = createHarness();
  const command = commands.get("show-me");
  await events.get("session_start")({}, ctx());

  await command.handler("off", ctx());
  assert.equal(await events.get("before_agent_start")({ systemPrompt: "BASE" }), undefined);

  await command.handler("", ctx());
  assert.match((await events.get("before_agent_start")({ systemPrompt: "BASE" })).systemPrompt, /SHOW-ME MODE ACTIVE/);
  await command.handler("status", ctx());

  assert.deepEqual(appendedEntries, [
    { customType: "show-me-mode", data: { active: false } },
    { customType: "show-me-mode", data: { active: true } },
  ]);
  assert.deepEqual(notifications.at(-1), { message: "Show Me: on.", level: "info" });
  assert.deepEqual(statuses, [
    { key: "show-me", value: "[SHOW-ME]" },
    { key: "show-me", value: undefined },
    { key: "show-me", value: "[SHOW-ME]" },
    { key: "show-me", value: "[SHOW-ME]" },
  ]);
});

test("restores the latest active-branch mode", async () => {
  const { events, ctx } = createHarness();
  await events.get("session_start")({}, ctx([
    { type: "custom", customType: "show-me-mode", data: { active: true } },
    { type: "custom", customType: "show-me-mode", data: { active: false } },
  ]));

  assert.equal(await events.get("before_agent_start")({ systemPrompt: "BASE" }), undefined);
});

test("handles a missing event or system prompt without injecting undefined", async () => {
  const { events, ctx } = createHarness();
  await events.get("session_start")({}, ctx());

  for (const event of [undefined, null, {}]) {
    const result = await events.get("before_agent_start")(event);
    assert.match(result.systemPrompt, /^SHOW-ME MODE ACTIVE/);
    assert.doesNotMatch(result.systemPrompt, /undefined/);
  }
});
