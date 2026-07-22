# pi-vertex-anthropic

## WARNING: GCP Credits do not cover anthropic models. Don't find this out the hard way. You probably don't need this extension.

Run **Anthropic Claude models on Google Cloud Vertex AI** inside [pi](https://github.com/earendil-works/pi-coding-agent) — so your Claude usage bills against your **GCP project** instead of an Anthropic API key.

- No Anthropic API key.
- No pi `/login` flow — authentication is ambient via Google **Application Default Credentials (ADC)**.
- No `gcloud` subprocess per request — auth is handled in-process by `@anthropic-ai/vertex-sdk`.

---

## Prerequisites

- The [gcloud CLI](https://cloud.google.com/sdk/docs/install) installed.
- A GCP project with **billing enabled** (Vertex partner models are not free-tier).
- Permission to accept model terms in that project (`roles/aiplatform.user` or higher).

---

## End-user setup (one time)

### 1. Install / update the gcloud CLI

```bash
gcloud --version                 # confirm it's installed
gcloud components update         # optional: get the latest
```

### 2. Log in and set your project

```bash
gcloud auth login                        # logs in the gcloud CLI itself
gcloud config set project <your-project> # e.g. my-team-prod-123456
```

### 3. Set up Application Default Credentials (ADC)

This is the credential the extension actually uses at runtime. It is **separate** from
`gcloud auth login` above.

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project <your-project>
```

- The first command writes `~/.config/gcloud/application_default_credentials.json`.
- The second sets the **quota/billing project** — Vertex requires this or you'll get a
  "quota project which is not set" error.

> **Alternatives to ADC login** (pick one, all auto-detected):
> - Service account key: `export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json`
> - Running on GCE/GKE/Cloud Run: the attached service account is used automatically.

### 4. Enable the Vertex AI API

```bash
gcloud services enable aiplatform.googleapis.com --project <your-project>
```

### 5. Enable each Claude model in Model Garden ⚠️ console-only

**This is the step people miss.** Each Claude model must be individually enabled in your
project by accepting Anthropic's EULA. **There is no gcloud command for this** — it is a
console click-through:

1. Open **Vertex AI → Model Garden**:
   `https://console.cloud.google.com/vertex-ai/model-garden?project=<your-project>`
2. Search for the Claude model you want (e.g. *Claude Sonnet 5*).
3. Open its model card → **Enable** → accept the Anthropic terms (EULA).
4. Repeat for every model you intend to use (Opus, Haiku, etc. are enabled separately).

Until a model is enabled, requests to it return:

```
404 ... Publisher model .../publishers/anthropic/models/<model> was not found
or your project does not have access to it.
```

### 6. Select a model in pi

Model IDs use a **version suffix**: `@default` for the latest, or `@YYYYMMDD` to pin a
specific version (e.g. `claude-haiku-4-5@20251001`).

```bash
pi --list-models | grep vertex-anthropic
pi --model "vertex-anthropic/claude-sonnet-5@default" -p "hello"
```

Quote the model string — the `@` can trip up some shells.

---

## Configuration (optional env vars)

| Variable | Purpose | Default |
|---|---|---|
| `ANTHROPIC_VERTEX_PROJECT_ID` / `GOOGLE_CLOUD_PROJECT` / `GCLOUD_PROJECT` | GCP project | read from the ADC file (`project_id` / `quota_project_id`) |
| `GOOGLE_CLOUD_LOCATION` / `CLOUD_ML_REGION` | Vertex region | `global` |
| `GOOGLE_APPLICATION_CREDENTIALS` | path to a service-account key (instead of ADC login) | — |

**Region note:** `global` (multi-region routing) works for the newest models. Some models are
only served in specific regions — if you get a 404 for an *enabled* model, try pinning a region:

```bash
GOOGLE_CLOUD_LOCATION=us-east5 pi --model "vertex-anthropic/claude-sonnet-5@default" -p "hi"
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Failed to acquire Google OAuth credentials` | ADC missing/expired | `gcloud auth application-default login` |
| `... quota project ... is not set` | no billing project on ADC | `gcloud auth application-default set-quota-project <project>` |
| `404 ... model ... was not found or your project does not have access` | model not enabled in Model Garden, **or** wrong region, **or** missing `@version` suffix | Enable it in Model Garden (step 5); ensure the id ends in `@default`; try `GOOGLE_CLOUD_LOCATION=us-east5` |
| `no GCP project resolvable` | project not set anywhere | set `ANTHROPIC_VERTEX_PROJECT_ID` or `set-quota-project` |
| Model missing from `pi --list-models` | not enabled here / extension not loaded | it only lists models this extension registers; enablement is separate |

Which models are enabled in your project (read-only check):

```bash
gcloud ai model-garden models list --project <your-project> | grep -i claude
```

---

---

## Using Vertex with other coding agents (Claude Code, Conductor)

**This extension is for [pi](https://github.com/earendil-works/pi-coding-agent).** Claude Code and
Conductor are separate tools with their **own native Vertex support** — they don't use this
extension. But the GCP-side prerequisites above are identical: do **steps 1–5** first
(gcloud login, ADC + quota project, enable the API, and accept the Model Garden EULA for each
model), then configure the tool.

### Claude Code

Docs: <https://code.claude.com/docs/en/google-vertex-ai>

**Easiest:** run `claude`, then `/login` → **3rd-party platform** → **Google Vertex AI**, and follow
the wizard (rerun anytime with `/setup-vertex`). It detects your project/region, verifies which
models you can invoke, and writes everything to `~/.claude/settings.json`.

**Manual (env vars):**

```bash
export CLAUDE_CODE_USE_VERTEX=1
export CLOUD_ML_REGION=global
export ANTHROPIC_VERTEX_PROJECT_ID=<your-project>

# Pin models to what you enabled in Model Garden (use @default or @YYYYMMDD suffixes):
export ANTHROPIC_DEFAULT_SONNET_MODEL='claude-sonnet-5'
export ANTHROPIC_DEFAULT_HAIKU_MODEL='claude-haiku-4-5@20251001'

# When a model isn't served on the global endpoint, override its region:
export VERTEX_REGION_CLAUDE_HAIKU_4_5=us-east5
```

Auto-refresh expired credentials via `~/.claude/settings.json`:

```json
{
  "gcpAuthRefresh": "gcloud auth application-default login",
  "env": {
    "CLAUDE_CODE_USE_VERTEX": "1",
    "CLOUD_ML_REGION": "global",
    "ANTHROPIC_VERTEX_PROJECT_ID": "<your-project>"
  }
}
```

Verify with `/status` — the *API provider* line should read **Google Vertex AI**.

### Conductor

Docs: <https://www.conductor.build/docs/reference/settings/reference>

Conductor drives Claude Code under the hood, so the Claude Code env vars apply. In
`~/.conductor/settings.toml` (user) or `<repo>/.conductor/settings.toml` (repo):

```toml
claude_provider   = "Vertex"
vertex_project_id = "<your-project>"

[environment_variables]
CLOUD_ML_REGION = "global"
# Per-model region override when a model isn't on the global endpoint:
# VERTEX_REGION_CLAUDE_HAIKU_4_5 = "us-east5"
```

### Prompt for your coding agent

Don't want to read the docs? Paste this into Claude Code / Conductor / your agent of choice and
let it drive the setup (replace the two placeholders):

> I want to run Claude models through Google Cloud Vertex AI in **<TOOL>** so usage bills to my GCP
> project instead of an Anthropic API key. My GCP project is **<PROJECT_ID>**. Read this tool's
> official Vertex AI docs first, then walk me through and run the setup: (1) `gcloud auth login`
> and Application Default Credentials (`gcloud auth application-default login` +
> `set-quota-project`); (2) enabling the Vertex AI API (`aiplatform.googleapis.com`); (3) which
> Claude models I must enable in Vertex AI Model Garden by accepting Anthropic's EULA in the
> console, and how to verify them (`gcloud ai model-garden models list | grep -i claude`); (4) the
> exact env vars / settings this tool needs (provider, project ID, region, and model pins). Note:
> Vertex model IDs require a version suffix (`@default` for latest, or `@YYYYMMDD`), and some
> models are only served in specific regions such as `us-east5`, not `global` — a wrong ID or
> region returns a 404 "model not found or your project does not have access." Finish by sending
> a test message to confirm it works.

---

## How it works

- Model metadata (cost, context window, thinking config) is read live from pi-ai's own Anthropic
  registry via `getModel`, so it stays in sync with pi's built-in Claude models.
- Streaming injects an `AnthropicVertex` client into pi-ai's built-in Anthropic `stream()` via the
  documented `client` option — so message conversion, tool calls, prompt caching, and extended
  thinking all come from pi, just pointed at Vertex.
- Only pi-ai's **compat surface** is imported. pi remaps `@earendil-works/pi-ai` to a bundled
  `compat.js` for extensions, so deep subpath imports (`/api/*`, `/providers/*`) do **not** resolve
  and are avoided.

## Editing the model list

Models are declared in [`extensions/vertex-anthropic.ts`](extensions/vertex-anthropic.ts) in
`VERTEX_MODEL_IDS` (`{ vertexId, baseId }`): `vertexId` is what Vertex expects (with `@version`),
`baseId` is the key in pi-ai's Anthropic registry that metadata is copied from. Add a model there
and enable it in Model Garden.

## Test

```bash
npm test   # spawns `pi --list-models` and asserts every model registers
```

This smoke test catches load/registration regressions (e.g. a bad import silently disabling the
whole extension). It does **not** make a live Vertex call.
