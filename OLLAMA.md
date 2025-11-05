# Ollama Integration Reference

This document explains how the GitHub Copilot Chat extension (Bring-Your-Own-Key mode) communicates with an Ollama server. It enumerates every HTTP request, the expected payloads, validation rules, and derived metadata so that an Ollama-compatible API can be reimplemented from scratch.

## Architecture Summary

- `OllamaLMProvider` is registered in `src/extension/byok/vscode-node/byokContribution.ts` and is constructed with the configurable base URL (`github.copilot.chat.byok.ollamaEndpoint`, default `http://localhost:11434`).
- On startup or whenever the model list is requested, the provider enforces a minimum server version (`>= 0.6.4`) via `GET /api/version` before any other call succeeds.
- The available model list is discovered through `GET /api/tags`, and each model is further hydrated via `POST /api/show` to collect capability metadata.
- Chat traffic then flows through `BaseOpenAICompatibleLMProvider` and `OpenAIEndpoint`, which reuse the same base URL with a `/v1` suffix to talk to OpenAI-compatible endpoints (`/v1/chat/completions` or `/v1/responses`).
- Responses are streamed and processed by shared OpenAI tooling (`CopilotLanguageModelWrapper`, `ChatEndpoint`) so the Ollama surface must match OpenAI semantics closely.

## Configuration Entry Points

| Setting | Declared In | Default | Description |
| --- | --- | --- | --- |
| `github.copilot.chat.byok.ollamaEndpoint` | `package.json` & `src/platform/configuration/common/configurationService.ts` | `http://localhost:11434` | Absolute base URL used for every Ollama request (both `/api/*` and `/v1/*`). |

## HTTP Layer and Header Semantics

Every request travels through the shared networking layer (`src/platform/networking/common/networking.ts` together with the platform-specific fetchers). Servers that gate on headers can rely on the following behaviour:

- `User-Agent`: Always set to `GitHubCopilotChat/<extension-version>` unless the user overrides it manually before the request reaches the provider. This value originates from the fetcher implementations (`BaseFetchFetcher` and `NodeFetcher`).
- `X-VSCode-User-Agent-Library-Version`: Indicates which low-level fetcher is active. Expected values include `electron-fetch`, `node-fetch`, or `node-http`. The extension may change fetchers automatically if a transport fails, so servers should accept all of them.
- `Authorization`: The BYOK Ollama provider uses `BYOKAuthType.None`, but the networking layer still emits an `Authorization: Bearer ` header with an empty token. An Ollama-compatible server must tolerate either an empty bearer token or the complete absence of the header.
- `Content-Type`: All POST requests send JSON bodies and include `Content-Type: application/json`.
- Diagnostic headers attached to chat requests (`/v1/*`):
  - `X-Request-Id`: Unique per request.
  - `X-Interaction-Type` and `OpenAI-Intent`: Identify the feature invoking the request.
  - `X-GitHub-Api-Version`: Fixed at `2025-05-01`.
- Custom headers supplied via model metadata (for example, future proxies) are sanitized by `OpenAIEndpoint._sanitizeCustomHeaders` to remove forbidden or suspicious headers (reserved names, `proxy-*`, `sec-*`, control characters) before they are sent.

## Endpoint Catalogue

| Purpose | Method & Path | Consumed By | Required Response Fields | Notes |
| --- | --- | --- | --- | --- |
| Version gate | `GET /api/version` | `_checkOllamaVersion()` | `version` string | Must report semantic version `>= 0.6.4` for the integration to proceed. |
| Model listing | `GET /api/tags` | `getAllModels()` | `models[]` array with `model` identifiers | Additional metadata (`name`, `digest`, `modified_at`, `size`) is accepted but only `model` is required today. |
| Model details | `POST /api/show` | `_getOllamaModelInformation()` | `capabilities[]`, `model_info` map | Supplies context window, feature support, and human-friendly naming. |
| Chat completions | `POST /v1/chat/completions` | `OpenAIEndpoint` | OpenAI Chat Completions schema | Used when a model does not claim support for the Responses API. |
| Responses API | `POST /v1/responses` | `OpenAIEndpoint` | OpenAI Responses schema | Selected automatically when model metadata advertises `ModelSupportedEndpoint.Responses`. |

> Base URL reminder: `/api/...` and `/v1/...` routes share the configured root URL (for example `http://localhost:11434`).

## Endpoint Specifications

### `GET /api/version`

**Request**

- Method: `GET`
- Headers: none beyond the defaults listed above

**Response**

```json
{
	"version": "0.6.5"
}
```

**Validation**

- The provider parses the JSON payload into the `OllamaVersionResponse` shape (`{ version: string }`).
- `_isVersionSupported()` compares the dotted version string to the hard-coded minimum (`0.6.4`). Missing components are treated as zero.
- If the check fails, the user receives: `Ollama server version <version> is not supported... Please upgrade to version 0.6.4 or higher.`
- Any network or parsing failure results in: `Unable to verify Ollama server version...` while preserving the underlying error in logs.

### `GET /api/tags`

**Request**

- Method: `GET`
- No request body

**Response shape**

```json
{
	"models": [
		{
			"name": "llama3",
			"model": "llama3:8b",
			"digest": "sha256:3c8f...",
			"modified_at": "2024-05-01T12:00:00Z",
			"size": 5347737600
		}
	]
}
```

- `model` (string, required): Unique identifier passed to `/api/show` and `/v1/...` endpoints.
- `name` (string, optional): Display name. If omitted the identifier is shown to the user instead.
- `digest` (string, optional): Preferred format `sha256:<hex>`. The extension does not currently verify the digest but exposing it allows future integrity checks and gives operators a way to reason about model provenance.
- `modified_at`, `size`, or other metadata can be emitted for observability; they are ignored by the extension today but retained in logs when tracing is enabled.

**Validation & caching**

- On success, each entry triggers `_getOllamaModelInformation(model)` to hydrate capabilities (see below). Results are cached in `_modelCache` to avoid redundant lookups on subsequent calls.
- An exception thrown during parsing or fetching is rewrapped as `Failed to fetch models from Ollama...` unless it originated from the earlier version gate, in which case the original message is preserved.

### `POST /api/show`

**Request**

- Method: `POST`
- Headers: `Content-Type: application/json`
- Body:

```json
{
	"model": "llama3:8b"
}
```

**Response shape** (`OllamaModelInfoAPIResponse`)

```json
{
	"template": "(optional prompt template string)",
	"capabilities": ["tools", "vision"],
	"details": { "family": "llama3" },
	"model_info": {
		"general.basename": "llama3",
		"general.architecture": "llama3",
		"llama3.context_length": 8192
	}
}
```

**Validation & derived values**

- Context window: the provider looks for `model_info["${architecture}.context_length"]`. If missing, it falls back to `4096`.
- Output tokens: if the context window is `< 4096`, output tokens default to half the window; otherwise they are clamped at `4096`.
- Input tokens: computed as `contextWindow - maxOutputTokens`.
- Capabilities: `capabilities.includes("tools")` enables tool-calling (function invocation); `capabilities.includes("vision")` enables image input. Other strings are ignored today but can be added without breaking compatibility.
- Display name: `model_info["general.basename"]` if present; otherwise the raw model ID is used.
- The resulting `BYOKModelCapabilities` object is stored in `_modelCache` and handed to `resolveModelInfo()` so the chat subsystem receives a fully-populated `IChatModelInformation` record.

### `/v1/chat/completions` and `/v1/responses`

- Base URL: `${ollamaBaseUrl}/v1`.
- Endpoint selection: `OpenAIEndpoint` checks the `supported_endpoints` field inside `IChatModelInformation`. If it contains `ModelSupportedEndpoint.Responses`, the Requests API (`POST /v1/responses`) is used; otherwise the classic Chat Completions endpoint (`POST /v1/chat/completions`) is used.

#### Chat request payload

- JSON body originates from `ChatEndpoint.createRequestBody()` and includes OpenAI-compatible fields such as `model`, `messages`, `stream`, `temperature`, `tool_choice`, and `tools`.
- `OpenAIEndpoint.interceptBody()` performs additional normalization:
  - Removes empty `tools` arrays entirely.
  - Ensures every function tool has a `parameters` object (`{ "type": "object", "properties": {} }` when the spec is omitted).
  - Drops `max_tokens` so the server may default to its configured maximum. When “thinking” support is advertised, the value is moved into `max_completion_tokens` and `temperature` is stripped.
  - Adds `stream_options: { include_usage: true }` for non-Responses streaming requests so that usage totals appear in the final streaming chunk.

#### Headers and retries

- In addition to the defaults documented earlier, chat requests always receive the telemetry headers (`X-Request-Id`, `X-Interaction-Type`, `OpenAI-Intent`, `X-GitHub-Api-Version`).
- The networking layer may retry once automatically on transient transport errors (`ECONNRESET`, `ETIMEDOUT`, HTTP/2 transport resets) after disconnecting all active fetchers.

#### Streaming expectations

- The client expects standard OpenAI streaming semantics (Server Sent Events with `data:` frames). Each chunk should either contain delta content or tool-call deltas. The final frame should include usage statistics when `stream_options.include_usage` is true.
- For the Responses API, the JSON contract defined by OpenAI must be followed so that `CopilotLanguageModelWrapper` can interpret reasoning, tool calls, and content arrays.

## Derived Metadata and Validation Summary

| Property | Source | Fallback / Notes |
| --- | --- | --- |
| `maxInputTokens` | `/api/show` → context length minus output tokens | Defaults to `4096` when context is unknown. |
| `maxOutputTokens` | Calculated from context length | Half the context window if `< 4096`, otherwise `4096`. |
| `toolCalling` | `/api/show` → `capabilities.includes("tools")` | `false` when absent. |
| `vision` | `/api/show` → `capabilities.includes("vision")` | `false` when absent. |
| Display name | `/api/show` → `model_info["general.basename"]` | Falls back to the raw model ID. |
| Supported endpoints | Derived from `BYOKKnownModels` or defaults | Controls whether `/v1/responses` is used. |
| Version compatibility | `/api/version` | Requests abort until server reports `>= 0.6.4`. |

## Error Surfaces Observed by the Client

- Version mismatch produces a user-visible prompt instructing the user to upgrade Ollama.
- Network or JSON parsing issues while loading `/api/tags` are presented as `Failed to fetch models from Ollama...` with guidance to verify the endpoint URL or server availability.
- Downstream chat failures are wrapped by `hydrateBYOKErrorMessages()` so any `streamError` or rate-limit payload from the server is surfaced verbatim in the chat UI.

## Implementation Checklist for an Ollama-Compatible Server

1. Serve `GET /api/version` with a semantic version string at or above `0.6.4`.
2. Serve `GET /api/tags` with a `models` array. Provide `model`, and optionally `name`, `digest` (`sha256:<hex>`), `size`, and `modified_at` for operators that need provenance data.
3. Implement `POST /api/show` to return `capabilities` and a `model_info` map containing at least `general.basename`, `general.architecture`, and `${architecture}.context_length`.
4. Expose OpenAI-compliant `/v1/chat/completions` (and optionally `/v1/responses`) endpoints. Support streaming, tool calls, vision payloads, and the usage accounting flags described above.
5. Accept the header set used by the extension (including an empty bearer token and `X-VSCode-User-Agent-Library-Version`).
6. Return consistent error payloads so that the extension relays actionable information to the user.

Fulfilling the checklist above yields a drop-in replacement for the upstream Ollama runtime within the GitHub Copilot Chat BYOK experience.
