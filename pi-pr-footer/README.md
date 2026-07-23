# pi-pr-footer

Shows the current branch's open PR URL in [pi](https://github.com/mariozechner/pi)'s footer status area, if one exists.

## Install

From the monorepo:

```bash
pi install https://github.com/hybrd-oss/pi-extensions
```

## Behavior

Runs `gh pr view --json url -q .url` for the current repo/branch at session start and after every agent turn, and shows the URL (dim) in the footer via `ctx.ui.setStatus`. If there's no `gh` CLI, no PR, or `gh` isn't authenticated, the status is hidden.

**Prerequisites:** [GitHub CLI](https://cli.github.com/) (`gh`), authenticated, inside a GitHub repo checkout.

## License

MIT
