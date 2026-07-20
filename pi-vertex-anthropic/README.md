# @mbattagl/pi-vertex-anthropic

Run **Anthropic Claude models on Google Cloud Vertex AI** inside [pi](https://github.com/earendil-works/pi-coding-agent) — so your Claude usage bills against your **GCP project / credits** instead of an Anthropic API key.

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
