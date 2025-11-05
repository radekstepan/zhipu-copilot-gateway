# Ollama Integration Reference

This document explains how the GitHub Copilot Chat extension (in Bring-Your-Own-Key mode) communicates with an Ollama server. It enumerates every HTTP request, the expected payloads, validation rules, and derived metadata so that an Ollama-compatible API can be reimplemented from scratch.

## Architecture Summary

The integration between VSCode Copilot and an Ollama-compatible server follows a two-stage process:

1.  **Discovery and Capability Assessment**: On startup, Copilot's `OllamaLMProvider` probes the server to identify its version and available models. It uses the `/api/*` endpoints for this. It fetches details for each model to understand its capabilities, such as context window size and tool support.
2.  **Chat Completions**: Once models are identified, all chat requests are routed through a generic `OpenAIEndpoint` provider. This component treats the Ollama server as a standard OpenAI-compatible API, sending requests to the `/v1/chat/completions` endpoint.

Because chat requests and responses are processed by shared tooling that expects OpenAI's API semantics, any compatible server must adhere closely to that specification, especially for streaming and tool calls.

## HTTP Layer and Header Semantics

All requests dispatched from Copilot include a consistent set of HTTP headers. A compatible server must be prepared to handle them.

*   **`User-Agent`**: Set to `GitHubCopilotChat/<extension-version>`.
*   **`Authorization`**: The Ollama provider uses a "None" authentication type, but the networking layer still sends an `Authorization: Bearer ` header with an empty token. A compatible server **must** accept requests with this header.
*   **`Content-Type`**: All `POST` requests include `Content-Type: application/json`.
*   **Diagnostic Headers**: Chat requests to `/v1/*` endpoints include additional headers for telemetry and routing:
    *   `X-Request-Id`: A unique UUID for the request.
    *   `X-Interaction-Type` / `OpenAI-Intent`: Identifies the VSCode feature (e.g., 'copilot-chat') that initiated the call.
    *   `X-GitHub-Api-Version`: A fixed version string, currently `2025-05-01`.

## Endpoint Catalogue

| Purpose | Method & Path | Consumed By | Required Response Fields | Notes |
| --- | --- | --- | --- | --- |
| Version Gate | `GET /api/version` | `OllamaLMProvider` | `version` (string) | Must be a semantic version `>= 0.6.4`. |
| Model Listing | `GET /api/tags` | `OllamaLMProvider` | `models[]` array with `model` identifiers | Fetches the list of available model tags. |
| Model Details | `POST /api/show` | `OllamaLMProvider` | `capabilities[]`, `model_info` map | Provides context window, feature support, and display names. |
| Chat Completions | `POST /v1/chat/completions` | `OpenAIEndpoint` | OpenAI Chat Completions schema | The primary endpoint for handling chat requests. |

> **Note**: Both `/api/*` and `/v1/*` routes share the same configured base URL (e.g., `http://localhost:11434`).

## Endpoint Specifications

### `GET /api/version`

*   **Purpose**: To ensure the Ollama server is a compatible version.
*   **Request**: `GET /api/version`
*   **Response**:
    ```json
    {
    	"version": "0.6.5"
    }
    ```
*   **Validation**: The extension performs a semantic version comparison against the minimum required version (`0.6.4`). If this check fails, the integration is halted, and the user is prompted to upgrade.

### `GET /api/tags`

*   **Purpose**: To discover the available models.
*   **Request**: `GET /api/tags`
*   **Response**:
    ```json
    {
    	"models": [
    		{
    			"name": "glm-4.6",
    			"model": "glm-4.6:latest",
    			"modified_at": "2024-05-01T12:00:00Z",
    			"size": 8149190253,
            "digest": "sha256:..."
    		}
    	]
    }
    ```
*   **Validation**: The extension iterates through the `models` array and uses the `model` field to call `/api/show` for more details. Other fields are ignored.

### `POST /api/show`

*   **Purpose**: To retrieve detailed capabilities for a specific model.
*   **Request Body**:
    ```json
    {
    	"model": "glm-4.6:latest"
    }
    ```
*   **Response Shape**:
    ```json
    {
    	"capabilities": ["tools", "vision"],
    	"model_info": {
    		"general.basename": "glm-4.6",
    		"general.architecture": "glm",
    		"glm.context_length": 32768
    	}
    }
    ```*   **Derived Metadata**:
    *   **Context Window**: Extracted from `model_info["${architecture}.context_length"]`. Defaults to `4096` if not found.
    *   **Max Output Tokens**: Calculated as half the context window if the window is `< 4096`, otherwise clamped to `4096`.
    *   **Max Input Tokens**: Calculated as `contextWindow - maxOutputTokens`.
    *   **Tool Calling**: Enabled if the `capabilities` array includes `"tools"`.
    *   **Vision**: Enabled if the `capabilities` array includes `"vision"`.
    *   **Display Name**: Uses `model_info["general.basename"]`; otherwise falls back to the model ID.

### `POST /v1/chat/completions`

*   **Purpose**: To handle chat generation requests.
*   **Request Body**: Follows the standard OpenAI Chat Completions API schema, including `model`, `messages`, `stream`, `tools`, and `tool_choice`. The Copilot client may alter the request:
    *   It often removes the `max_tokens` parameter to allow the server to use its configured default.
    *   For streaming requests, it adds `stream_options: { include_usage: true }` to receive token counts in the final chunk of the response.
*   **Response**: Must also follow the OpenAI schema for both streaming (Server-Sent Events) and non-streaming responses.

## Tool Calling Integration

The tool-calling feature requires precise adherence to the OpenAI protocol.

1.  **Capability Detection**: A model is marked as tool-capable only if its `/api/show` response includes `"tools"` in the `capabilities` array. If this flag is absent, Copilot will strip the `tools` property from all requests sent to that model.

2.  **Request Payload**: When a user's prompt triggers a tool, the request body will contain a `tools` array where each element is a function definition. If the user's code constrains the model to a specific tool, a `tool_choice` object will also be present.

3.  **Streaming Response Contract**: For tool calling to work correctly in streaming mode, the server must follow a specific sequence of SSE events:
    a. First, send a delta containing the initial `tool_calls` array. This chunk should define the tool's `id`, `type: "function"`, and `function.name`, with an empty `arguments` string.
    ```text
    data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"tool_abc","type":"function","function":{"name":"search","arguments":""}}]}}]}
    ```
    b. Next, stream one or more subsequent deltas containing fragments of the JSON `arguments` string.
    ```text
    data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"query\":"}}]}}]}
    data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"Copilot\"}"}}]}}]}
    ```
    c. Finally, send a concluding chunk where the `finish_reason` for the choice is explicitly set to `"tool_calls"`. This signals to Copilot that it should stop listening for content and execute the tool.
    ```text
    data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}
    ```
    d. The stream must end with the standard `data: [DONE]` marker.

4.  **Non-Streaming Response**: The consolidated response must place the complete `tool_calls` array inside `choices[i].message` and set `choices[i].finish_reason` to `"tool_calls"`.

## Implementation Checklist for a Compatible Server

1.  [ ] Implement `GET /api/version` and return a semantic version string `>= 0.6.4`.
2.  [ ] Implement `GET /api/tags` to return a list of available models in the expected JSON format.
3.  [ ] Implement `POST /api/show` to return model details, including `capabilities` and `model_info` with context length.
4.  [ ] Implement `POST /v1/chat/completions` with support for both streaming and non-streaming modes, adhering to the OpenAI specification.
5.  [ ] For tool-enabled models, correctly parse the `tools` and `tool_choice` arrays in requests.
6.  [ ] For tool-calling responses, precisely follow the OpenAI streaming protocol, ensuring the final `finish_reason` is `"tool_calls"`.
7.  [ ] Ensure the server correctly handles the `Authorization: Bearer ` header (with an empty token).
8.  [ ] Handle the `stream_options: { include_usage: true }` parameter in requests and include a final `usage` object in the last SSE chunk before `[DONE]`.
