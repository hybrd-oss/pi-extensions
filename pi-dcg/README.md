# pi-dcg

A [pi](https://github.com/mariozechner/pi) package that intercepts bash commands through [Destructive Command Guard (DCG)](https://github.com/Dicklesworthstone/destructive_command_guard) to catch dangerous operations before they execute.

## Install

```bash
pi install npm:@mbattagl/pi-dcg
```

## What it does

Intercepts every `bash` tool call and pipes it through DCG. A denied command is blocked automatically by default, and Pi receives DCG's complete response as the blocked tool result so the agent can choose a safe next step.

## Configuration

The default mode is `block`: no prompt, no command execution. Set `prompt` only when you want the old interactive options (**Block**, **Allow Once**, **Allowlist Rule**):

```json
// ~/.config/pi-dcg/config.json
{ "mode": "prompt" }
```

`PI_DCG_MODE=block|prompt` overrides the file for one Pi process. Reload Pi after changing the file.

In non-interactive mode (print/JSON), destructive commands are always auto-blocked.

## Prerequisites

Install DCG:

```bash
pip install destructive_command_guard
```

See https://github.com/Dicklesworthstone/destructive_command_guard for details.

## License

MIT
