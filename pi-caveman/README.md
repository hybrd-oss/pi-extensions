# pi-caveman

Caveman mode for [pi](https://github.com/mariozechner/pi): terse responses with full technical accuracy.

## Install

From the monorepo:

```bash
pi install https://github.com/hybrd-oss/pi-extensions
```

Standalone package metadata is available in this directory for future split publishing.

## Commands

- `/caveman [lite|full|ultra|wenyan-*|off] [message]` — toggle caveman mode, optionally send a message.
- `/caveman-help` — show command help.
- `/caveman-commit` — generate terse Conventional Commit messages.
- `/caveman-review` — generate terse code review comments.
- `/caveman-compress` — compress natural-language memory files into caveman prose.
- `/caveman-stats` — show estimated output token savings while caveman mode was active.

## Subagent inheritance

When caveman mode is active and the main agent calls the `subagent` tool, caveman context is inherited automatically by every spawned subagent task (`task`, `tasks[]`, and `chain[]`). There is no config switch: if parent caveman is on, child subagents must use caveman style too.

## Modes

- `lite` — tight professional prose.
- `full` — smart caveman fragments; default.
- `ultra` — ultra terse, arrows/tables where useful.
- `wenyan-lite`, `wenyan-full`, `wenyan-ultra` — classical Chinese compression levels.

## Config

Optional default mode:

```bash
CAVEMAN_DEFAULT_MODE=ultra
```

Or:

```json
// ~/.config/caveman/config.json
{
  "defaultMode": "ultra"
}
```

## Not included

Cavecrew/caveman-specific agents are intentionally not shipped. Use Pi's existing `scout`, `worker`, `reviewer`, or project agents through the `subagent` tool; caveman mode inherits automatically when active.

## License

MIT
