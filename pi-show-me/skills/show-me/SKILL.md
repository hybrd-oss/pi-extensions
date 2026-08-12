---
name: show-me
description: Explain the current topic with concise diagrams, code-shape sketches, and focused HTML artifacts when a visual makes the key point clearer.
license: MIT
disable-model-invocation: true
---

# Show Me

Help the user understand the current topic visually. Apply this throughout the session, but do not add a visual merely to prove the mode is active. For trivial answers, routine edits, and short completion reports, use normal prose or code when that is clearer. Use at most one primary visual by default.

Honor stricter active brevity or output modes. Pick the smallest view that makes the key point clear. In Pi, prefer text trees, pseudocode, and diffs; use Mermaid when its source is useful to copy into a renderer; reserve HTML artifacts for concepts too dense for those formats.

- Show logic or an algorithm as pseudocode:

```text
on(save)
  if content is unchanged
    return cached result
  write new content
  return fresh result
```

- Show runtime control flow as a call tree:

```text
submitForm
  createSession
    persistPrompt
    launchAgent
  navigateToSession
```

- Show UI structure as a component tree, including state and module boundaries that matter:

```tsx
<SessionPage> (apps/example/src/routes/session.tsx)
  useSessionEvents()
  <SessionToolbar>
    <RunSkillButton> (packages/ui)
```

- Show file responsibility or a broad refactor as a shallow file tree:

```text
src/
|-- commands/       # parses user actions
|-- sessions/       # owns session state
`-- transport/      # sends API requests
```

- Show component interaction, control flow, or data flow with Mermaid:

```mermaid
sequenceDiagram
    participant User
    participant UI
    participant Daemon
    User->>UI: choose command
    UI->>Daemon: send expanded prompt
    Daemon-->>UI: stream result
```

- Use `diff` when the point is what changes and the surrounding shape already exists. Match the diff shape to the topic.

For a component change:

```diff
 <SessionPage>
   useSessionEvents()
   <SessionToolbar>
+    <RunSkillButton />
   <SessionTimeline>
+    <SkillResultCard />
```

For a file-layout change:

```diff
 src/
 |-- commands/
+|   `-- show-me.ts       # expands the slash command
 |-- sessions/
-`-- transport.ts
+`-- transport/
+    |-- client.ts
+    `-- stream.ts
```

For a call-tree or call-stack change:

```diff
 submitForm
   createSession
     persistPrompt
+    expandSkillMention
     launchAgent
-  navigateToSession
+  navigateToSession
+    subscribeToEvents
```

For a state or control-flow change:

```diff
 on(save)
-  write content
+  if content is unchanged
+    return cached result
+  write content
+  invalidate cache
```

- Show the whole block when most of it is new, when omitted context would hide ownership or order, or when the user needs a copyable target shape:

```ts
function expandSkill(command: string): string {
  const skillName = command.slice(1)
  return `use the ${skillName} skill`
}
```

- For a visual UI, layout, state comparison, or concept too dense for Mermaid, write one focused HTML file — a diagram, an infographic, or a short slide deck, whichever fits the point. Match the product's colors, type, spacing, and components; use real labels and data; support desktop and mobile. Report its path. Open it only when a supported desktop opener is available.

Place each visual next to the short text it supports. Keep only the calls, files, props, states, and boundaries needed to answer the user's current question.
