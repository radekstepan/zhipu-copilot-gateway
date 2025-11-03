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
