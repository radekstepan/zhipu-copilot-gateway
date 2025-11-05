import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import httpProxy from "http-proxy";
import fs from "fs";
import path from "path";
import { IncomingMessage } from "http";
import { PassThrough } from "stream";
import { config, initializeConfig } from "./config";
import { chunkText } from "./ollama";
import { normalizeModelName, zhipuChatOnce, ZhipuChatRequest } from "./zhipu";

// ---- Upstream Ollama you actually run
const OLLAMA_UPSTREAM = process.env.OLLAMA_UPSTREAM || "http://127.0.0.1:11435";

// ---- Load GLM models list for mock responses
const MODELS_PATH = path.join(__dirname, "models.json");
let GLM_MODELS: any[] = [];
try {
  const modelsData = fs.readFileSync(MODELS_PATH, "utf8");
  GLM_MODELS = JSON.parse(modelsData);
  console.log(`Loaded ${GLM_MODELS.length} models from ${MODELS_PATH}`);
} catch (error) {
  console.error("Failed to load models.json:", error);
  console.error("Attempted path:", MODELS_PATH);
  console.error("__dirname:", __dirname);
  // Provide fallback models
  GLM_MODELS = [];
}

// ---- Logging config
// Default to <repo-root>/logs so logs are easy to find during development.
// When running the compiled dist code __dirname points to dist/, which is less convenient.
const DEFAULT_LOG_DIR = path.join(process.cwd(), "logs");
const LOG_DIR = process.env.LOG_DIR || DEFAULT_LOG_DIR;
const RECORD = process.env.RECORD !== "0";
const LOG_MAX_PREVIEW = Number(process.env.LOG_MAX_PREVIEW || 64 * 1024);

if (RECORD) {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
}

type AnyObj = Record<string, any>;

interface ExchangeContext {
  id: string;
  start: number;
  method: string;
  url: string;
  headers: AnyObj;
  reqBodyBuf?: Buffer;
  reqPath: string | null;
  rspPath: string;
  jsonPath: string;
  startPath: string;
  finalized: boolean;
}

const exchanges = new WeakMap<IncomingMessage, ExchangeContext>();

// ---- CORS for Electron/VS Code preflights
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
  "Access-Control-Max-Age": "600",
  "Vary": "Origin",
};

let configInitialized = false;
let configInitError: Error | null = null;
function ensureZhipuConfig() {
  if (configInitialized) return;
  if (configInitError) throw configInitError;
  try {
    initializeConfig();
    configInitialized = true;
  } catch (error) {
    configInitError = error as Error;
    throw configInitError;
  }
}

export function buildServer(mode: 'proxy' | 'direct' = 'proxy'): FastifyInstance {
  const app = Fastify({ logger: true });

  // Keep raw body for exact forwarding
  app.addContentTypeParser("*", { parseAs: "buffer" }, (req, body, done) => {
    (req as any).rawBody = body as Buffer;
    done(null, body);
  });
  // Ensure JSON content-types also populate rawBody (Fastify has a default JSON parser which would bypass the "*" parser)
  app.addContentTypeParser(["application/json", "application/*+json"], { parseAs: "buffer" }, (req, body, done) => {
    (req as any).rawBody = body as Buffer;
    done(null, body);
  });

  // Health
  app.get("/", async () => ({
    ok: true, upstream: OLLAMA_UPSTREAM, record: RECORD, log_dir: RECORD ? LOG_DIR : null
  }));

  // OPTIONS preflight handlers (prevent VS Code hangs)
  const preflight = async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.headers(CORS_HEADERS).code(204).send();
  };
  // Single global OPTIONS preflight handler (covers all routes)
  app.options("/*", preflight);

  // Mock Ollama API endpoints when in direct mode
  if (mode === 'direct') {
    // GET /api/version - return mock Ollama version
    app.get("/api/version", async (request, reply) => {
      const versionResponse = { version: "0.12.9" };
      reply
        .headers({ "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS })
        .code(200)
        .send(versionResponse);
    });

    // GET /api/tags - return GLM models as if they were Ollama models
    app.get("/api/tags", async (request, reply) => {
      const tagsResponse = { models: GLM_MODELS };
      reply
        .headers({ "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS })
        .code(200)
        .send(tagsResponse);
    });

    // POST /api/show - return model information
    app.post("/api/show", async (request, reply) => {
      const rawBody = (request as any).rawBody as Buffer | undefined;
      let requestedName = "";
      
      if (rawBody && rawBody.length > 0) {
        try {
          const body = JSON.parse(rawBody.toString("utf8"));
          requestedName = body.name || body.model || "";
        } catch {}
      }
      
      // Find the model in GLM_MODELS or use the first one as default
      const model = GLM_MODELS.find(m => m.name === requestedName || m.model === requestedName) || GLM_MODELS[0] || {
        name: requestedName || "glm-4.6:latest",
        model: requestedName || "glm-4.6:latest",
        modified_at: new Date().toISOString(),
        size: 8149190253,
        digest: "f4031aab637d1ffa37b42570452ae0e4fad0314754d17ded67322e4b95836f8a",
        details: {
          parent_model: "",
          format: "gguf",
          family: "glm",
          families: ["glm"],
          parameter_size: "12.2B",
          quantization_level: "Q4_K_M"
        }
      };

      const showResponse = {
        license: "",
        modelfile: `# Modelfile generated by \"ollama show\"\n# To build a new Modelfile based on this, replace FROM with:\n# FROM ${model.name}\n\nFROM ${model.name}\nPARAMETER temperature 1\nPARAMETER top_p 0.95`,
        parameters: "temperature                    1\ntop_p                          0.95",
        template: "",
        details: model.details || {},
        model_info: {},
        modified_at: model.modified_at || new Date().toISOString()
      };

      reply
        .headers({ "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS })
        .code(200)
        .send(showResponse);
    });
  }

  app.post("/v1/chat/completions", async (request, reply) => {
    const rawBody = (request as any).rawBody as Buffer | undefined;
    const headersCopy = { ...(request.headers as AnyObj) };
    const ctx = createExchangeContext(request.method, request.url, headersCopy, rawBody);

    const finalize = (
      status: number,
      headers: AnyObj,
      bodyBuffer: Buffer | null,
      bodyContentType?: string,
      bodyFilePath?: string | null,
      note?: string,
    ) => {
      if (ctx.finalized) return;
      let preview: Buffer | null = null;
      if (bodyBuffer && bodyBuffer.length > 0) {
        const limit = Math.min(bodyBuffer.length, LOG_MAX_PREVIEW);
        preview = bodyBuffer.subarray(0, limit);
      }
      ctx.finalized = true;
      writeExchangeLog(ctx, {
        status,
        headers,
        bodyPreviewBuffer: preview,
        bodyContentType,
        bodyFilePath: bodyFilePath || null,
        note,
      });
    };

    const respondWithError = (status: number, message: string, detail?: string) => {
      const errorHeaders = { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS };
      const payload = { error: message, detail };
      const payloadBuffer = Buffer.from(JSON.stringify(payload), "utf8");
      reply.headers(errorHeaders).code(status).send(payload);
      let bodyFilePath: string | null = null;
      if (RECORD) {
        try {
          fs.writeFileSync(ctx.rspPath, payloadBuffer);
          bodyFilePath = ctx.rspPath;
        } catch (fileErr) {
          console.error("Failed to write error response log", fileErr);
        }
      }
      finalize(status, errorHeaders, payloadBuffer, errorHeaders["content-type"], bodyFilePath, message);
    };

    if (!rawBody || rawBody.length === 0) {
      return respondWithError(400, "Invalid request body", "Expected JSON body");
    }

    const bodyText = safeToString(rawBody);
    let openaiReq: AnyObj;
    try {
      openaiReq = JSON.parse(bodyText) as AnyObj;
    } catch (error) {
      return respondWithError(400, "Invalid JSON", (error as Error).message);
    }

    if (!openaiReq || typeof openaiReq !== "object") {
      return respondWithError(400, "Invalid request body", "Expected JSON object");
    }

    const requestedModel = typeof openaiReq.model === "string" ? openaiReq.model : "";
    if (!requestedModel) {
      return respondWithError(400, "Missing model");
    }

    if (!Array.isArray(openaiReq.messages)) {
      return respondWithError(400, "Invalid messages", "messages must be an array");
    }

    const toPlainText = (content: unknown): string => {
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .map((part) => {
            if (typeof part === "string") return part;
            if (!part || typeof part !== "object") return "";
            if (typeof (part as AnyObj).text === "string") return (part as AnyObj).text as string;
            if (typeof (part as AnyObj).input_text === "string") return (part as AnyObj).input_text as string;
            return "";
          })
          .join("");
      }
      if (content && typeof content === "object") {
        if (typeof (content as AnyObj).text === "string") return (content as AnyObj).text as string;
        if (typeof (content as AnyObj).input_text === "string") return (content as AnyObj).input_text as string;
      }
      return "";
    };

    const messageCandidates = openaiReq.messages as AnyObj[];
    const normalizedMessages: ZhipuChatRequest["messages"] = [];
    for (let i = 0; i < messageCandidates.length; i++) {
      const msg = messageCandidates[i];
      if (!msg || typeof msg !== "object" || typeof msg.role !== "string") {
        return respondWithError(400, "Invalid messages", `Message at index ${i} missing role`);
      }
      const role = msg.role as string;
      if (role !== "system" && role !== "user" && role !== "assistant") {
        return respondWithError(400, "Invalid messages", `Unsupported role '${role}' at index ${i}`);
      }
      const plain = toPlainText((msg as AnyObj).content);
      normalizedMessages.push({ role, content: plain });
    }

    try {
      ensureZhipuConfig();
    } catch (error) {
      return respondWithError(500, "Configuration error", (error as Error).message);
    }

    // Map unknown/non-GLM models (e.g., "gemma3:12b") to a default GLM model so Zhipu accepts the request
    const normalizedRequested = normalizeModelName(requestedModel);
    const targetModel = normalizedRequested.startsWith("glm")
      ? normalizedRequested
      : config.DEFAULT_ZHIPU_MODEL;

    const zhipuReq: ZhipuChatRequest = {
      model: targetModel,
      messages: normalizedMessages,
      stream: false,
    };
    if (typeof openaiReq.temperature === "number") zhipuReq.temperature = openaiReq.temperature;
    if (typeof openaiReq.top_p === "number") zhipuReq.top_p = openaiReq.top_p;
    if (typeof openaiReq.max_tokens === "number") zhipuReq.max_tokens = openaiReq.max_tokens;

    let zhipuResp: AnyObj;
    try {
      zhipuResp = (await zhipuChatOnce(zhipuReq)) as AnyObj;
    } catch (error) {
      const detail = (error as Error).message;
      return respondWithError(502, "Upstream error", detail);
    }

    const choices = (Array.isArray(zhipuResp.choices) ? zhipuResp.choices : [])
      .map((choice: AnyObj, idx: number) => {
        const role = typeof choice?.message?.role === "string"
          ? choice.message.role
          : typeof choice?.delta?.role === "string"
            ? choice.delta.role
            : "assistant";
        const content = typeof choice?.message?.content === "string"
          ? choice.message.content
          : typeof choice?.delta?.content === "string"
            ? choice.delta.content
            : "";
        return {
          index: typeof choice.index === "number" ? choice.index : idx,
          message: { role, content },
          finish_reason: typeof choice.finish_reason === "string" || choice.finish_reason === null
            ? choice.finish_reason
            : null,
        };
      });

    if (choices.length === 0) {
      choices.push({
        index: 0,
        message: { role: "assistant", content: "" },
        finish_reason: "stop",
      });
    }

    const accumulatedContent = choices.map((c) => c.message?.content || "").join("");
    const completion: AnyObj = {
      id: typeof zhipuResp.id === "string" ? zhipuResp.id : `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      object: "chat.completion",
      created: typeof zhipuResp.created === "number" ? zhipuResp.created : Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices,
    };
    if (zhipuResp.usage) completion.usage = zhipuResp.usage;

    const streamRequested = Boolean(openaiReq.stream);
    if (streamRequested) {
      reply.hijack();
      const streamHeaders: AnyObj = {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        ...CORS_HEADERS,
      };
      reply.raw.writeHead(200, streamHeaders);

      const baseChunk = {
        id: completion.id,
        object: "chat.completion.chunk",
        created: completion.created,
        model: completion.model,
      };

      const eventChunks: string[] = [];
      eventChunks.push(`data: ${JSON.stringify({
        ...baseChunk,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      })}\n\n`);

      const contentPieces = chunkText(accumulatedContent || "");
      for (const piece of contentPieces) {
        if (!piece) continue;
        eventChunks.push(`data: ${JSON.stringify({
          ...baseChunk,
          choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
        })}\n\n`);
      }

      const finishReason = choices.find((c) => c.finish_reason)?.finish_reason || "stop";
      eventChunks.push(`data: ${JSON.stringify({
        ...baseChunk,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      })}\n\n`);
      eventChunks.push("data: [DONE]\n\n");

      for (const chunk of eventChunks) {
        reply.raw.write(chunk);
      }
      reply.raw.end();

      const streamedBuffer = Buffer.from(eventChunks.join(""), "utf8");
      let bodyFilePath: string | null = null;
      if (RECORD) {
        try {
          fs.writeFileSync(ctx.rspPath, streamedBuffer);
          bodyFilePath = ctx.rspPath;
        } catch (fileErr) {
          console.error("Failed to write stream response log", fileErr);
        }
      }

      finalize(200, streamHeaders, streamedBuffer, streamHeaders["Content-Type"] as string, bodyFilePath, "converted non-stream response to SSE");
      return;
    }

    const jsonHeaders = { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS };
    reply.headers(jsonHeaders).code(200).send(completion);
    const bodyBuffer = Buffer.from(JSON.stringify(completion), "utf8");
    let bodyFilePath: string | null = null;
    if (RECORD) {
      try {
        fs.writeFileSync(ctx.rspPath, bodyBuffer);
        bodyFilePath = ctx.rspPath;
      } catch (fileErr) {
        console.error("Failed to write completion response log", fileErr);
      }
    }
    finalize(200, jsonHeaders, bodyBuffer, jsonHeaders["content-type"], bodyFilePath);
  });

  // Only set up proxy in proxy mode
  if (mode === 'proxy') {
    const proxy = httpProxy.createProxyServer({
      target: OLLAMA_UPSTREAM,
      changeOrigin: true,
      selfHandleResponse: true, // we tee & stream manually
      ignorePath: false,
    });

  proxy.on("error", (err, req, res) => {
    const detail = (err as Error).message;
    const payload = JSON.stringify({ error: "Proxy error", detail });
    const payloadBuffer = Buffer.from(payload, "utf8");
    const nodeReq = req as IncomingMessage | undefined;
    if (nodeReq) {
      const ctx = exchanges.get(nodeReq);
      if (ctx && !ctx.finalized) {
        ctx.finalized = true;
        exchanges.delete(nodeReq);
        writeExchangeLog(ctx, {
          status: 502,
          headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
          bodyPreviewBuffer: payloadBuffer,
          bodyContentType: "application/json; charset=utf-8",
          bodyFilePath: null,
          note: `proxy error: ${detail}`,
        });
      } else if (!ctx) {
        const headers = ((req as any)?.headers ? { ...(req as any).headers } : {}) as AnyObj;
        const fallbackCtx = createExchangeContext(req?.method || "UNKNOWN", req?.url || "", headers, (req as any)?.rawBody as Buffer | undefined);
        fallbackCtx.finalized = true;
        writeExchangeLog(fallbackCtx, {
          status: 502,
          headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
          bodyPreviewBuffer: payloadBuffer,
          bodyContentType: "application/json; charset=utf-8",
          bodyFilePath: null,
          note: `proxy error: ${detail}`,
        });
      }
    }

    const r = res as any as FastifyReply["raw"];
    try {
      if (!r.headersSent) {
        r.writeHead(502, { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS });
      }
      r.end(payload);
    } catch {}
  });

  // Forward raw request body upstream
  proxy.on("proxyReq", (proxyReq: any, req: any) => {
    const nodeReq = req as IncomingMessage;
    const ctx = exchanges.get(nodeReq);
    const raw = (ctx?.reqBodyBuf ?? (req as any)?.rawBody) as Buffer | undefined;
    if (!raw || raw.length === 0) return;

    proxyReq.setHeader("content-length", raw.length);
    try {
      proxyReq.write(raw);
    } finally {
      proxyReq.end();
    }
  });

  proxy.on("proxyRes", (proxyRes, req: any, res: any) => {
    const nodeReq = req as IncomingMessage;
    let ctx = exchanges.get(nodeReq);
    if (!ctx) {
      const headers = ((req as any)?.headers ? { ...(req as any).headers } : {}) as AnyObj;
      ctx = createExchangeContext(req?.method || "UNKNOWN", req?.url || "", headers, (req as any)?.rawBody as Buffer | undefined);
      exchanges.set(nodeReq, ctx);
    }

    if (!ctx) return;
    const context = ctx;

    // Debug: record when we receive an upstream response for a context
    try {
      console.log(JSON.stringify({ proxyResReceived: { id: context.id, method: context.method, url: context.url, start: context.start, upstream_status: proxyRes.statusCode } }));
    } catch {}

    const upstreamHeaders = { ...(proxyRes.headers as AnyObj) };
    const ct = (upstreamHeaders["content-type"] || upstreamHeaders["Content-Type"]) as string | undefined;
    const isSse = ct ? /text\/event-stream/i.test(ct) : false;

    delete upstreamHeaders["content-length"];
    delete upstreamHeaders["Content-Length"];

    if (isSse) {
      upstreamHeaders["Cache-Control"] = upstreamHeaders["Cache-Control"] || "no-cache, no-transform";
      upstreamHeaders["Connection"] = upstreamHeaders["Connection"] || "keep-alive";
    }

    Object.assign(upstreamHeaders, CORS_HEADERS);

    if (!res.headersSent) {
      res.writeHead(proxyRes.statusCode || 200, upstreamHeaders);
    }

    let preview = Buffer.alloc(0);
    let rspFile: fs.WriteStream | null = null;
    let responseBodyPath: string | null = null;
    let wroteResponseBytes = false;

    if (RECORD) {
      try {
        rspFile = fs.createWriteStream(context.rspPath, { flags: "w" });
        responseBodyPath = context.rspPath;
      } catch (error) {
        rspFile = null;
        responseBodyPath = null;
        console.error("Failed to open response log file", error);
      }
    }

    const clientSink = new PassThrough();

    const closeResponseFile = () => {
      if (rspFile) {
        try { rspFile.end(); } catch {}
        rspFile = null;
      }
    };

    const finalize = (note?: string) => {
      if (context.finalized) return;
      // Debug: announce finalize so we can correlate missing .json files
      try {
        console.log(JSON.stringify({ finalize: { id: context.id, url: context.url, note: note || null, upstream_status: proxyRes.statusCode } }));
      } catch {}
      if (!wroteResponseBytes && responseBodyPath) {
        try { fs.rmSync(responseBodyPath, { force: true }); } catch {}
        responseBodyPath = null;
      }
      context.finalized = true;
      exchanges.delete(nodeReq);
      writeExchangeLog(context, {
        status: proxyRes.statusCode || 0,
        headers: proxyRes.headers as AnyObj,
        bodyPreviewBuffer: preview.length > 0 ? preview : null,
        bodyContentType: ct,
        bodyFilePath: wroteResponseBytes ? responseBodyPath : null,
        note,
      });
    };

    clientSink.on("data", (chunk) => {
      try { res.write(chunk); } catch {}
      if (RECORD && preview.length < LOG_MAX_PREVIEW) {
        const remaining = LOG_MAX_PREVIEW - preview.length;
        preview = Buffer.concat([preview, chunk.subarray(0, remaining)]);
        if (preview.length > LOG_MAX_PREVIEW) preview = preview.subarray(0, LOG_MAX_PREVIEW);
      }
      if (RECORD && rspFile) {
        try {
          rspFile.write(chunk);
          wroteResponseBytes = true;
        } catch (fileErr) {
          console.error("Failed to write response log", fileErr);
          try { rspFile.destroy(); } catch {}
          rspFile = null;
          try { fs.rmSync(context.rspPath, { force: true }); } catch {}
          responseBodyPath = null;
          wroteResponseBytes = false;
        }
      }
    });

    clientSink.on("end", () => {
      try { if (!res.writableEnded) res.end(); } catch {}
      closeResponseFile();
      finalize();
    });

    clientSink.on("error", (streamErr) => {
      try { if (!res.writableEnded) res.end(); } catch {}
      closeResponseFile();
      finalize(`clientSink error: ${(streamErr as Error).message}`);
    });

    (res as any).on?.("close", () => {
      closeResponseFile();
      try { proxyRes.unpipe(clientSink); } catch {}
      if (!proxyRes.destroyed) {
        try { proxyRes.destroy(); } catch {}
      }
      finalize("client connection closed");
    });

    proxyRes.on("aborted", () => {
      closeResponseFile();
      finalize("upstream aborted");
    });

    proxyRes.on("error", (upstreamErr) => {
      closeResponseFile();
      finalize(`proxyRes error: ${(upstreamErr as Error).message}`);
    });

    proxyRes.pipe(clientSink);
  });

  function handler(request: FastifyRequest, reply: FastifyReply) {
    const reqBodyBuf = (request as any).rawBody as Buffer | undefined;
    const headersCopy = { ...(request.headers as AnyObj) };
    const ctx = createExchangeContext(request.method, request.url, headersCopy, reqBodyBuf);
    exchanges.set(request.raw as IncomingMessage, ctx);

    reply.hijack();
    // Loud marker in console so you know proxy was hit
    console.log(JSON.stringify({ proxying: { method: request.method, url: request.url, target: `${OLLAMA_UPSTREAM}${request.url}` } }));
    proxy.web(request.raw, reply.raw, {
      target: OLLAMA_UPSTREAM,
      changeOrigin: true,
      selfHandleResponse: true,
    });
  }

  // Proxy all Ollama/Copilot routes
  app.all("/api/*", handler);
  app.all("/v1/*", handler);
  }

  app.log.info("🚀 Gateway listening on http://127.0.0.1:11434");
  if (mode === 'proxy') {
    app.log.info(`🔁 Proxy mode: Forwarding to ${OLLAMA_UPSTREAM}`);
  } else {
    app.log.info("🎯 Direct mode: Calling Zhipu GLM directly (no local Ollama required)");
  }
  if (RECORD) app.log.info(`🧾 Streaming logs to ${LOG_DIR}`);
  return app;
}

// ---- Helpers

function createExchangeContext(method: string, url: string, headers: AnyObj, reqBodyBuf?: Buffer): ExchangeContext {
  const headersCopy = { ...headers };
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const ctx: ExchangeContext = {
    id,
    start: Date.now(),
    method,
    url,
    headers: headersCopy,
    reqBodyBuf,
    reqPath: reqBodyBuf && reqBodyBuf.length > 0 ? path.join(LOG_DIR, `${id}.request`) : null,
    rspPath: path.join(LOG_DIR, `${id}.response`),
    jsonPath: path.join(LOG_DIR, `${id}.json`),
    startPath: path.join(LOG_DIR, `${id}.start.json`),
    finalized: false,
  };

  if (RECORD) {
    try {
      const startEntry = {
        id,
        phase: "start",
        timestamp: new Date().toISOString(),
        request: { method, url, headers: headersCopy },
      };
      fs.writeFileSync(ctx.startPath, JSON.stringify(startEntry, null, 2));
    } catch (error) {
      console.error("Failed to write start log", error);
    }

    if (ctx.reqPath && reqBodyBuf && reqBodyBuf.length > 0) {
      try {
        fs.writeFileSync(ctx.reqPath, reqBodyBuf);
      } catch (error) {
        console.error("Failed to write request log", error);
      }
    }
  }

  return ctx;
}

interface FinalizePayload {
  status: number;
  headers: AnyObj;
  bodyPreviewBuffer?: Buffer | null;
  bodyContentType?: string;
  bodyFilePath?: string | null;
  note?: string;
}

function writeExchangeLog(ctx: ExchangeContext, payload: FinalizePayload) {
  if (!RECORD) return;

  const requestContentType = (ctx.headers["content-type"] || ctx.headers["Content-Type"]) as string | undefined;
  const responseContentType = payload.bodyContentType
    || (payload.headers["content-type"] || payload.headers["Content-Type"]) as string | undefined;

  const entry = {
    id: ctx.id,
    timestamp: new Date().toISOString(),
    duration_ms: Date.now() - ctx.start,
    note: payload.note || undefined,
    request: {
      method: ctx.method,
      url: ctx.url,
      headers: ctx.headers,
      body_preview: previewDecode(requestContentType, ctx.reqBodyBuf),
      body_file: ctx.reqBodyBuf && ctx.reqBodyBuf.length > 0 && ctx.reqPath ? relPath(ctx.reqPath) : null,
    },
    response: {
      status: payload.status,
      headers: payload.headers,
      body_preview: payload.bodyPreviewBuffer ? previewDecode(responseContentType, payload.bodyPreviewBuffer) : null,
      body_file: payload.bodyFilePath ? relPath(payload.bodyFilePath) : null,
    },
  };

  try {
    fs.writeFileSync(ctx.jsonPath, JSON.stringify(entry, null, 2));
    console.log(JSON.stringify({ saved: ctx.jsonPath }));
  } catch (error) {
    console.error("Failed to write log JSON", error);
  }
}

function relPath(p: string) {
  try { return path.relative(process.cwd(), p); } catch { return p; }
}
function previewDecode(contentType: string | undefined, buf?: Buffer | null) {
  if (!buf || buf.length === 0) return null;
  const text = safeToString(buf);
  if (!contentType) return text.slice(0, LOG_MAX_PREVIEW);
  if (/json/i.test(contentType)) {
    try { return JSON.parse(text); } catch { return text.slice(0, LOG_MAX_PREVIEW); }
  }
  if (/text|ndjson|event-stream/i.test(contentType)) return text.slice(0, LOG_MAX_PREVIEW);
  return { base64_preview: buf.subarray(0, Math.min(buf.length, LOG_MAX_PREVIEW)).toString("base64") };
}
function safeToString(buf: Buffer) {
  try { return buf.toString("utf8"); } catch { return ""; }
}
