# pi-dcg

A [pi](https://github.com/mariozechner/pi) package that intercepts bash commands through [Destructive Command Guard (DCG)](https://github.com/Dicklesworthstone/destructive_command_guard) to catch dangerous operations before they execute.

## Install

```bash
pi install npm:@mbattagl/pi-dcg
```

## What it does

Intercepts every `bash` tool call and pipes it through DCG. When a destructive command is detected, you get an interactive prompt with options to:

- **Block** — prevent the command from running
- **Allow Once** — run this specific command once
- **Allowlist Rule** — permanently allow the matched rule

In non-interactive mode (print/JSON), destructive commands are auto-blocked.

## Prerequisites

Install DCG:

```bash
pip install destructive_command_guard
```

See https://github.com/Dicklesworthstone/destructive_command_guard for details.

## License

MIT
