# Zhipu Ollama Gateway

An Ollama-compatible server that serves **Zhipu GLM** models. This project implements the Ollama API specification required for **GitHub Copilot** and other clients, but uses the Zhipu API as the backend for chat completions.

Secrets are injected with **Infisical** (`infisical run -- …`).

## Features

- ✅ Implements the Ollama API specification for Copilot compatibility.
- ✅ `GET /api/version` – Returns a compatible Ollama version.
- ✅ `GET /api/tags` – Lists available GLM models from `src/models.json`.
- ✅ `POST /api/show` – Returns model details for the client.
- ✅ `POST /v1/chat/completions` – Streams responses from the Zhipu GLM API.
- ✅ Does **not** require a local Ollama instance to be running.

## Quick Start

### Prerequisites
- Node.js 20+
- Infisical CLI logged in: `infisical login`
- In your Infisical project, set `ZHIPU_API_KEY` (or `ZHIPUAI_API_KEY`) to your Zhipu key.

### Run Locally

```bash
# Install dependencies
npm install

# Run the development server (with hot-reloading)
npm run dev

# --- or ---

# Build and run the production server
npm run build
npm start
