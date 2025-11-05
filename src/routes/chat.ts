import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';
import { zhipuChatOnce, normalizeModelName, ZhipuChatRequest } from '../zhipu';
import { chunkText } from '../ollama';
import { CORS_HEADERS } from '../server';

type AnyObj = Record<string, any>;

export function registerChatRoutes(app: FastifyInstance<any, any, any, any>) {
  app.post('/v1/chat/completions', async (request: FastifyRequest, reply: FastifyReply) => {
    let openaiReq: AnyObj;
    try {
      const body = request.body as unknown;
      if (Buffer.isBuffer(body)) {
        openaiReq = JSON.parse(body.toString('utf8'));
      } else if (typeof body === 'string') {
        openaiReq = JSON.parse(body);
      } else {
        // already parsed object
        openaiReq = (body as AnyObj) || {};
      }
    } catch (error) {
      return reply.code(400).headers(CORS_HEADERS).send({ error: 'Invalid JSON request body' });
    }

    const { model: requestedModel, messages, stream: streamRequested, ...rest } = openaiReq;

    // (removed verbose debug payload logging)

    if (!requestedModel) {
      return reply.code(400).headers(CORS_HEADERS).send({ error: 'Missing "model" in request body' });
    }
    if (!Array.isArray(messages)) {
      return reply.code(400).headers(CORS_HEADERS).send({ error: '"messages" must be an array' });
    }

    // Map the requested model to a Zhipu-compatible model name.
    const normalizedModel = normalizeModelName(requestedModel);
    const targetModel = normalizedModel.startsWith('glm') ? normalizedModel : config.DEFAULT_ZHIPU_MODEL;

    const zhipuReq: ZhipuChatRequest = {
      model: targetModel,
      messages: messages.map((msg: any) => ({
        role: msg.role,
        content: msg.content,
      })),
      ...rest,
    };

    // Helper: extract textual content from a Zhipu choice (handles multiple shapes)
    const extractChoiceContent = (choice: any): string => {
      if (!choice) return '';
      // Common non-stream shape
      if (choice.message && typeof choice.message.content === 'string') return choice.message.content;
      // Streaming delta shape
      if (choice.delta && typeof choice.delta.content === 'string') return choice.delta.content;
      // Older/alternate fields
      if (typeof choice.text === 'string') return choice.text;
      if (typeof choice.content === 'string') return choice.content;
      // Fallback: try nested arrays or objects
      if (Array.isArray(choice.contents) && choice.contents.length) return String(choice.contents);
      return '';
    };

    // --- NON-STREAMING RESPONSE ---
    if (!streamRequested) {
      try {
        const zhipuResp = await zhipuChatOnce(zhipuReq);

        // (removed verbose upstream preview logging)

        // Build a normalized OpenAI-like response so clients receive consistent shape.
        const normalizedChoices = (zhipuResp.choices || []).map((c: any, idx: number) => {
          const content = extractChoiceContent(c);

          const message: { role: 'assistant'; content: string | null; tool_calls?: any[] } = {
            role: 'assistant',
            content: content || null, // Per OpenAI spec, content is null when tool_calls are present
          };

          if (c.message?.tool_calls) {
            message.tool_calls = c.message.tool_calls;
          }

          return {
            index: idx,
            message: message,
            finish_reason: c.finish_reason ?? null,
          };
        });

        const openaiResp = {
          id: zhipuResp.id,
          object: 'chat.completion',
          created: zhipuResp.created,
          model: requestedModel, // Return the model name the client requested
          choices: normalizedChoices,
          usage: zhipuResp.usage, // Pass usage stats through
        };

        // If no content or tool calls were extracted, log a warning
        if (normalizedChoices.every((c: any) => !c.message.content && !c.message.tool_calls)) {
          app.log.warn({ upstream: zhipuResp }, 'No assistant content or tool_calls could be extracted from Zhipu response');
        }

        return reply.code(200).headers(CORS_HEADERS).send(openaiResp);
      } catch (error: any) {
        app.log.error(error, 'Error calling Zhipu API');
        return reply.code(502).headers(CORS_HEADERS).send({ error: 'Upstream API error', detail: error.message });
      }
    }

    // --- STREAMING RESPONSE (SSE) ---
    try {
      const zhipuResp = await zhipuChatOnce(zhipuReq); // Simulate stream by getting full response first

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...CORS_HEADERS,
      });

      const baseChunk = {
        id: zhipuResp.id,
        object: 'chat.completion.chunk',
        created: zhipuResp.created,
        model: requestedModel,
      };

      // 1. Send role chunk
      const roleChunk = { ...baseChunk, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] };
      reply.raw.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

  const firstChoice = zhipuResp.choices?.[0];

      // 2. Send content or tool_calls
      if (firstChoice?.message?.tool_calls) {
        // Stream tool calls by chunking the arguments
        const toolCalls = firstChoice.message.tool_calls;
        for (let i = 0; i < toolCalls.length; i++) {
          const toolCall = toolCalls[i];
          // Send the tool call structure with an empty arguments string first
          const toolPreamble = {
            ...baseChunk,
            choices: [{
              index: 0,
              delta: { tool_calls: [{ index: i, id: toolCall.id, type: toolCall.type, function: { name: toolCall.function.name, arguments: '' } }] },
            }],
          };
          reply.raw.write(`data: ${JSON.stringify(toolPreamble)}\n\n`);

          // Stream the arguments string in pieces
          for (const piece of chunkText(toolCall.function.arguments, 32)) {
            const argsChunk = { ...baseChunk, choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: piece } }] } }] };
            reply.raw.write(`data: ${JSON.stringify(argsChunk)}\n\n`);
          }
        }
      } else {
        // Stream regular content
        const accumulatedContent = firstChoice ? extractChoiceContent(firstChoice) : '';
        for (const piece of chunkText(accumulatedContent, 32)) {
          const contentChunk = { ...baseChunk, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] };
          reply.raw.write(`data: ${JSON.stringify(contentChunk)}\n\n`);
        }
      }

      // 3. Send finish chunk
      const finishReason = firstChoice?.finish_reason ?? 'stop';
      const finishChunk = { ...baseChunk, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] };
      reply.raw.write(`data: ${JSON.stringify(finishChunk)}\n\n`);

      // 4. Send DONE signal
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
    } catch (error: any) {
      app.log.error(error, 'Error during Zhipu stream simulation');
      if (!reply.raw.headersSent) {
        reply.code(502).headers(CORS_HEADERS).send({ error: 'Upstream API error', detail: error.message });
      } else {
        reply.raw.end();
      }
    }
  });
}
