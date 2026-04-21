# pi-ask-question

Interactive question tool for [pi](https://github.com/mariozechner/pi) — ask users multiple-choice or freeform questions during agent conversations.

Inspired by Claude Code's `ask_user` tool, adapted for pi's extension system.

## Features

- **Multiple choice** — arrow-key selector with numbered options and a "Type something..." freeform fallback
- **Freeform text** — simple text input when no options are provided
- **Non-interactive safe** — gracefully errors in headless/print mode
- **Custom rendering** — styled tool call and result display in the TUI

## Usage

The LLM calls `ask_question` when it needs user input:

```
ask_question({ question: "Which framework?", options: [{ label: "SwiftUI" }, { label: "UIKit" }] })
```

Without options, it falls back to a freeform text input:

```
ask_question({ question: "What's the project name?" })
```
