import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import { config } from '../config';
import { zhipuChatOnce, zhipuChatStream, normalizeModelName, ZhipuChatRequest, ZhipuChatMessage } from '../zhipu';
import { CORS_HEADERS } from '../server';

type AnyObj = Record<string, any>;

export function registerChatRoutes(app: FastifyInstance<any, any, any, any>) {
  const handleChatRequest = async (request: FastifyRequest, reply: FastifyReply, endpoint: 'completions' | 'responses') => {
    let openaiReq: AnyObj;
    try {
      const body = request.body as unknown;
      if (Buffer.isBuffer(body)) {
        openaiReq = JSON.parse(body.toString('utf8'));
      } else if (typeof body === 'string') {
        openaiReq = JSON.parse(body);
      } else {
        openaiReq = (body as AnyObj) || {};
      }
    } catch (error) {
      return reply.code(400).headers(CORS_HEADERS).send({ error: 'Invalid JSON request body' });
    }

    const { model: requestedModel, messages, stream: streamRequested, ...rest } = openaiReq;

    if (!requestedModel) {
      return reply.code(400).headers(CORS_HEADERS).send({ error: 'Missing "model" in request body' });
    }
    if (!Array.isArray(messages)) {
      return reply.code(400).headers(CORS_HEADERS).send({ error: '"messages" must be an array' });
    }

    if (!messages.every((msg: AnyObj) => msg && typeof msg.role === 'string')) {
      return reply.code(400).headers(CORS_HEADERS).send({ error: 'Each message must include a string "role"' });
    }

    const normalizedModel = normalizeModelName(requestedModel);
    const targetModel = normalizedModel.startsWith('glm') ? normalizedModel : config.DEFAULT_ZHIPU_MODEL;

    const normalizeInboundMessage = (msg: AnyObj): ZhipuChatMessage => {
      if (!msg || typeof msg !== 'object') {
        return {
          role: 'user',
          content: typeof msg === 'string' ? msg : undefined,
        } as ZhipuChatMessage;
      }

      const normalized: AnyObj = { ...msg };

      if (Array.isArray(normalized.tool_calls)) {
        normalized.tool_calls = normalized.tool_calls.map((toolCall: AnyObj) => {
          if (!toolCall || typeof toolCall !== 'object') {
            return toolCall;
          }
          const tool: AnyObj = { ...toolCall };
          tool.type = tool.type ?? 'function';
          const fn = { ...(tool.function ?? {}) };
          if (fn.name === undefined) {
            fn.name = '';
          }
          if (typeof fn.arguments !== 'string') {
            try {
              fn.arguments = JSON.stringify(fn.arguments ?? {});
            } catch {
              fn.arguments = String(fn.arguments ?? '');
            }
          }
          tool.function = fn;
          return tool;
        });
      }

      if (Array.isArray(normalized.content)) {
        normalized.content = normalized.content.map((part: any) => {
          if (typeof part === 'string') {
            return part;
          }
          return part && typeof part === 'object' ? { ...part } : part;
        });
      }

      if (typeof normalized.role !== 'string') {
        normalized.role = 'user';
      }

      return normalized as ZhipuChatMessage;
    };

    const zhipuReq: ZhipuChatRequest = {
      model: targetModel,
      messages: (messages as AnyObj[]).map(normalizeInboundMessage),
      ...rest,
    };

    const extractChoiceContent = (choice: any): string => {
      if (!choice) return '';
      if (choice.message && typeof choice.message.content === 'string') return choice.message.content;
      if (choice.delta && typeof choice.delta.content === 'string') return choice.delta.content;
      if (typeof choice.text === 'string') return choice.text;
      if (typeof choice.content === 'string') return choice.content;
      if (Array.isArray(choice.contents) && choice.contents.length) return String(choice.contents);
      return '';
    };

    const normalizeToolCalls = (toolCalls: any[] | undefined): any[] | undefined => {
      if (!Array.isArray(toolCalls)) return undefined;
      return toolCalls.map((t: any) => {
        const out: any = { ...(t || {}) };
        if (!out.id) out.id = `call_${randomUUID()}`;
        out.type = 'function';
        out.function = out.function || { name: 'unnamed', arguments: '' };
        out.function.name = out.function.name || 'unnamed';
        if (typeof out.function.arguments !== 'string') {
          try {
            out.function.arguments = JSON.stringify(out.function.arguments ?? {});
          } catch (e) {
            out.function.arguments = String(out.function.arguments ?? '');
          }
        }
        return out;
      });
    };

    if (streamRequested) {
      // --- TRUE STREAMING RESPONSE (SSE) ---
      try {
        const zhipuStreamResponse = await zhipuChatStream(zhipuReq);

        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          ...CORS_HEADERS,
        });

        const isCompletions = endpoint === 'completions';
        let streamBuffer = '';
        let requestId = `chatcmpl-${randomUUID()}`;
        let created = Math.floor(Date.now() / 1000);
        let roleSent = false;

        const writeSse = (data: object) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);

        zhipuStreamResponse.data.on('data', (chunk: Buffer) => {
          streamBuffer += chunk.toString('utf-8');
          const lines = streamBuffer.split('\n');
          streamBuffer = lines.pop() || ''; // Keep the last partial line for the next chunk

          for (const line of lines) {
            if (!line.startsWith('data:')) continue;

            const dataStr = line.substring(5).trim();
            if (dataStr === '[DONE]') continue;

            try {
              const zhipuChunk = JSON.parse(dataStr);

              if (zhipuChunk.id && !roleSent) requestId = zhipuChunk.id;
              if (zhipuChunk.created && !roleSent) created = zhipuChunk.created;

              const baseChunk = {
                id: requestId,
                object: isCompletions ? 'chat.completion.chunk' : 'response.chunk',
                created: created,
                model: requestedModel,
              };

              if (!roleSent) {
                const roleDelta = { role: 'assistant' };
                writeSse(
                  isCompletions
                    ? { ...baseChunk, choices: [{ index: 0, delta: roleDelta }] }
                    : { ...baseChunk, outputs: [{ id: `${requestId}-0`, type: 'message', role: 'assistant', delta: roleDelta }] }
                );
                roleSent = true;
              }

              const choice = zhipuChunk.choices?.[0];
              if (!choice) continue;

              const delta = choice.delta || {};
              const finishReason = choice.finish_reason;

              if (delta.content) {
                const contentDelta = { content: delta.content };
                writeSse(
                  isCompletions
                    ? { ...baseChunk, choices: [{ index: 0, delta: contentDelta }] }
                    : { ...baseChunk, outputs: [{ id: `${requestId}-0`, type: 'message', delta: { content: { type: 'output_text', text: delta.content } } }] }
                );
              }

              if (delta.tool_calls) {
                // Replicate the specific tool_call sequence required by Copilot
                for (let i = 0; i < delta.tool_calls.length; i++) {
                  const toolCall = delta.tool_calls[i];
                  if (!toolCall.function || !toolCall.function.name) continue;

                  const toolHeaderDelta = { tool_calls: [{ index: i, id: toolCall.id, type: 'function', function: { name: toolCall.function.name, arguments: '' } }] };
                  writeSse(
                    isCompletions
                      ? { ...baseChunk, choices: [{ index: 0, delta: toolHeaderDelta }] }
                      : { ...baseChunk, outputs: [{ id: `${requestId}-${i}`, type: 'tool_call', delta: toolHeaderDelta }] }
                  );

                  const argsDelta = { tool_calls: [{ index: i, function: { arguments: toolCall.function.arguments || '' } }] };
                  writeSse(
                    isCompletions
                      ? { ...baseChunk, choices: [{ index: 0, delta: argsDelta }] }
                      : { ...baseChunk, outputs: [{ id: `${requestId}-${i}`, type: 'tool_call', delta: argsDelta }] }
                  );
                }
              }

              if (finishReason) {
                const finishChunk: any = isCompletions
                  ? { ...baseChunk, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }
                  : { ...baseChunk, outputs: [{ id: `${requestId}-0`, type: 'message', delta: {} }], finish_reason: finishReason };
                if (zhipuChunk.usage) finishChunk.usage = zhipuChunk.usage;
                writeSse(finishChunk);
              }
            } catch (e) {
              app.log.warn({ error: e, line }, 'Failed to parse or process upstream SSE chunk');
            }
          }
        });

        zhipuStreamResponse.data.on('end', () => {
          reply.raw.write('data: [DONE]\n\n');
          reply.raw.end();
        });

        zhipuStreamResponse.data.on('error', (err: Error) => {
          app.log.error(err, 'Upstream stream connection error');
          if (!reply.raw.writableEnded) {
            reply.raw.end();
          }
        });
      } catch (error: any) {
        app.log.error(error, `Error initiating stream with Zhipu API for /v1/${endpoint}`);
        if (!reply.raw.headersSent) {
          reply.code(502).headers(CORS_HEADERS).send({ error: 'Upstream API error', detail: error.message });
        } else if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      }
    } else {
      // --- NON-STREAMING RESPONSE ---
      try {
        const zhipuResp = await zhipuChatOnce(zhipuReq);
        const firstChoice = zhipuResp.choices?.[0];
        if (firstChoice?.message?.tool_calls) {
          firstChoice.message.tool_calls = normalizeToolCalls(firstChoice.message.tool_calls);
        }

        if (endpoint === 'completions') {
          const normalizedChoices = (zhipuResp.choices || []).map((c: any, idx: number) => {
            const content = extractChoiceContent(c);
            const message: { role: 'assistant'; content: string | null; tool_calls?: any[] } = {
              role: 'assistant',
              content: c.message?.tool_calls ? null : content,
            };
            if (c.message?.tool_calls) {
              message.tool_calls = normalizeToolCalls(c.message.tool_calls);
            }
            return { index: idx, message, finish_reason: c.finish_reason ?? 'stop' };
          });

          if (normalizedChoices.every((c) => !c.message.content && !c.message.tool_calls)) {
            app.log.warn({ upstream: zhipuResp }, 'No content or tool_calls extracted');
          }

          return reply.code(200).headers(CORS_HEADERS).send({
            id: zhipuResp.id,
            object: 'chat.completion',
            created: zhipuResp.created,
            model: requestedModel,
            choices: normalizedChoices,
            usage: zhipuResp.usage,
          });
        } else { // 'responses' endpoint
          const outputs = (zhipuResp.choices || []).map((c: any, idx: number) => {
            const contentText = extractChoiceContent(c);
            const output: any = {
              id: `${zhipuResp.id}-${idx}`,
              type: 'message',
              role: 'assistant',
              content: contentText ? [{ type: 'output_text', text: contentText }] : [],
              finish_reason: c.finish_reason ?? 'stop',
            };
            if (c.message?.tool_calls) {
              output.tool_calls = normalizeToolCalls(c.message.tool_calls);
            }
            if (c.reasoning) {
              output.reasoning = c.reasoning;
            }
            return output;
          });
          return reply.code(200).headers(CORS_HEADERS).send({
            id: zhipuResp.id,
            object: 'response',
            created: zhipuResp.created,
            model: requestedModel,
            outputs,
            usage: zhipuResp.usage,
          });
        }
      } catch (error: any) {
        app.log.error(error, `Error calling Zhipu API for /v1/${endpoint}`);
        if (!reply.raw.headersSent) {
          reply.code(502).headers(CORS_HEADERS).send({ error: 'Upstream API error', detail: error.message });
        } else {
          reply.raw.end();
        }
      }
    }
  };

  app.post('/v1/chat/completions', (req, rep) => handleChatRequest(req, rep, 'completions'));
  app.post('/v1/responses', (req, rep) => handleChatRequest(req, rep, 'responses'));
}
