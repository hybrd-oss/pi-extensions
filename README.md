# pi-extensions

A collection of [pi](https://github.com/mariozechner/pi) extensions by [hybrd-oss](https://github.com/hybrd-oss).

## Install

```bash
pi install https://github.com/hybrd-oss/pi-extensions
```

This installs all extensions. Then run `/reload` in pi to activate them.

To uninstall:

```bash
pi remove https://github.com/hybrd-oss/pi-extensions
```

## Extensions

### [pi-dcg](./pi-dcg)

Intercepts bash commands through [Destructive Command Guard (DCG)](https://github.com/Dicklesworthstone/destructive_command_guard) to catch dangerous operations before they execute.

**Prerequisites:** Install DCG with `pip install destructive_command_guard`

### [pi-web-tools](./pi-web-tools)

Provides `web_search` and `web_fetch` tools for searching and fetching web content.

**Prerequisites:** Set `BRAVE_SEARCH_API_KEY` in your environment ([free tier available](https://brave.com/search/api/))

### [pi-ask-question](./pi-ask-question)

Provides an interactive `ask_question` tool for asking users multiple-choice or freeform questions during agent conversations. Multiple choice shows an arrow-key selector; freeform falls back to text input.

### [pi-caveman](./pi-caveman)

Provides caveman mode (`/caveman`) plus terse commit/review/compress/help skills. When caveman mode is active, spawned `subagent` tasks inherit caveman style automatically. Cavecrew/caveman-specific agents are intentionally not shipped.

### [pi-show-me](./pi-show-me)

Provides an always-on visual-explanation mode with `/show-me on|off|status` and an explicit `/skill:show-me` command.

### [pi-orchestrator](./pi-orchestrator)

Provides orchestrator tools and commands for splitting large specs into worker tasks, running workers in per-task git worktrees, recording manifests, verifying runs, and merging completed worker branches into an integration worktree.

Baseline verification uses mock workers:

```bash
npm test
npm run test:orchestrator-smoke
```

### [pi-pr-footer](./pi-pr-footer)

Shows the current branch's open PR URL in pi's footer status area, if one exists. Requires the [GitHub CLI](https://cli.github.com/) (`gh`), authenticated.

### [pi-clear](./pi-clear)

Adds a `/clear` command that starts a fresh session (alias for `/new`).

### [pi-statusbar](./pi-statusbar)

macOS menu bar icon showing the status of all running pi sessions: spinning pie while a session is working, orange pie when one needs attention, dim pie when all idle. Clicking the icon lists each session and its state; closing the menu (or submitting input to a session) clears its attention state.

A tiny Swift daemon (compiled automatically on first use, requires Xcode Command Line Tools) owns the icon; sessions report state over `~/.pi/statusbar.sock`. The daemon exits when the last session ends. Disable the working animation via `~/.pi/agent/statusbar.json`: `{ "animate": false }`.

## License

MIT
