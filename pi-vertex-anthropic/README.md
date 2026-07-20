# @mbattagl/pi-vertex-anthropic

Claude on Google Cloud Vertex AI for [pi](https://github.com/earendil-works/pi-coding-agent), using **Application Default Credentials (ADC)** — no Anthropic API key, no `gcloud` subprocess per request. Point your GCP credits at Claude.

## Setup

1. Authenticate ADC once in your shell:
   ```bash
   gcloud auth application-default login
   gcloud auth application-default set-quota-project <your-project>   # optional but recommended
   ```
   (Or set `GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json`, or run on GCE/GKE.)

2. The extension is wired into this package's config. Select a model:
   ```bash
   pi --list-models | grep vertex-anthropic
   pi -m vertex-anthropic/claude-opus-4-8
   ```

There is **no `/login` flow** — auth is ambient via ADC.

## Config (optional env)

| Var | Purpose | Default |
|---|---|---|
| `ANTHROPIC_VERTEX_PROJECT_ID` / `GOOGLE_CLOUD_PROJECT` | GCP project | read from ADC file |
| `GOOGLE_CLOUD_LOCATION` | Vertex region | `global` (multi-region) |

## How it works

Model metadata is read live from pi-ai's own Anthropic registry (`getModel`), and streaming injects an `AnthropicVertex` client into pi-ai's built-in Anthropic `stream()` via the documented `client` option — so tool calls, caching, and thinking all come from pi. Only pi-ai's compat surface is imported (pi remaps the package for extensions; deep subpath imports do not resolve).

## Test

```bash
npm test   # spawns pi --list-models, asserts all models register
```
