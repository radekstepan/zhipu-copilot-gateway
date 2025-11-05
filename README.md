# Zhipu Ollama Gateway

Ollama-compatible proxy that forwards `/api/generate` and `/api/chat` to **Zhipu GLM** models, plus discovery endpoints (`/api/version`, `/api/tags`, `/api/show`). Designed for **GitHub Copilot → Ollama** integrations and other clients that speak the Ollama API.

Secrets are injected with **Infisical** (`infisical run -- …`).

## What works

- ✅ `/api/version` – returns an Ollama-like version
- ✅ `/api/tags` – lists proxy models from `src/models.json`
- ✅ `/api/show` – returns modelfile + details for selected model
- ✅ `/api/generate` – NDJSON-streams `response` chunks
- ✅ `/api/chat` – NDJSON-streams `message.content` chunks

> This gateway **does not** download local GGUF models; it simply **proxies** to Zhipu using your API key.

## Quick Start

### Prereqs
- Node.js 18+
- Infisical CLI logged in: `infisical login`
- In your Infisical project, set `ZHIPU_API_KEY` (or `ZHIPUAI_API_KEY`) to your Zhipu key.

### Run

```bash
npm i
npm run dev
# or
npm run build && npm start
# or from anywhere:
infisical run -- npx @radekstepan/zhipu-copilot-gateway
```

### Modes

The gateway supports two modes:

#### Proxy Mode (default)
Forwards requests to a local Ollama instance while also intercepting `/v1/chat/completions` to call Zhipu GLM:

```bash
npm start
# or
node dist/cli.js --mode proxy
```

In this mode:
- All `/api/*` and `/v1/*` routes (except `/v1/chat/completions`) are proxied to your local Ollama instance (default: `http://127.0.0.1:11435`)
- `/v1/chat/completions` is intercepted and routed to Zhipu GLM models
- Set `OLLAMA_UPSTREAM` environment variable to change the upstream Ollama URL

#### Direct Mode
Bypasses local Ollama entirely and mocks all Ollama endpoints while routing chat requests to Zhipu GLM:

```bash
node dist/cli.js --mode direct
```

In this mode:
- `/api/version` returns a mock Ollama version (0.12.9)
- `/api/tags` returns the list of GLM models from `models.json`
- `/v1/chat/completions` calls Zhipu GLM directly
- No local Ollama instance required

### CLI Options

```bash
node dist/cli.js --help

Options:
  --host        Host interface to bind (default: 127.0.0.1)
  -p, --port    Port to bind (default: 11434)
  -m, --mode    Mode: "proxy" or "direct" (default: proxy)
  -h, --help    Show help
```
