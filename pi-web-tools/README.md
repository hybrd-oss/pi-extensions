# pi-web-tools

A [pi](https://github.com/mariozechner/pi) package providing `web_search` and `web_fetch` tools.

## Install

```bash
pi install npm:@mbattagl/pi-web-tools
```

## Tools

### web_search

Search the web using the [Brave Search API](https://brave.com/search/api/).

- **query** (string, required) — search query
- **num_results** (number, optional, default 5, max 10) — number of results

Returns formatted results with title, URL, snippet. Includes knowledge panel/infobox when available.

### web_fetch

Fetch a web page and return its content as plain text.

- **url** (string, required) — URL to fetch

Strips HTML tags, scripts, and styles. Handles `text/*` and `application/json`. Results cached for 1 hour. 50KB max output.

## Setup

1. Sign up for Brave Search API at https://brave.com/search/api/ (free tier: 2,000 queries/month, no credit card)
2. Set `BRAVE_SEARCH_API_KEY` in your environment
3. Run `/reload` in pi

## License

MIT
