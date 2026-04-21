# pi-extensions

A collection of [pi](https://github.com/mariozechner/pi) extensions by [mibattaglia](https://github.com/mibattaglia).

## Install

```bash
pi install https://github.com/mibattaglia/pi-extensions
```

This installs all extensions. Then run `/reload` in pi to activate them.

To uninstall:

```bash
pi remove https://github.com/mibattaglia/pi-extensions
```

## Extensions

### [pi-dcg](./pi-dcg)

Intercepts bash commands through [Destructive Command Guard (DCG)](https://github.com/Dicklesworthstone/destructive_command_guard) to catch dangerous operations before they execute.

**Prerequisites:** Install DCG with `pip install destructive_command_guard`

### [pi-web-tools](./pi-web-tools)

Provides `web_search` and `web_fetch` tools for searching and fetching web content.

**Prerequisites:** Set `BRAVE_SEARCH_API_KEY` in your environment ([free tier available](https://brave.com/search/api/))

## License

MIT
