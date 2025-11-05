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

    // Debug: log incoming request summary
    try {
      app.log.debug({ model: requestedModel, messageCount: Array.isArray(messages) ? messages.length : 0, streamRequested }, 'Incoming OpenAI-compatible request');
    } catch (err) {
      // ignore logging errors
    }

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

    // Debug: log the Zhipu request shape (truncated)
    try {
      const sample = JSON.stringify({ model: zhipuReq.model, messages: zhipuReq.messages?.slice(0, 5) });
      app.log.debug({ sample: sample.slice(0, 1000) }, 'Prepared Zhipu request');
    } catch (err) {
      /* ignore */
    }

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
      if (Array.isArray(choice.contents) && choice.contents.length) return String(choice.contents[0]);
      return '';
    };

    // --- NON-STREAMING RESPONSE ---
    if (!streamRequested) {
      try {
        const zhipuResp = await zhipuChatOnce(zhipuReq);

        // Debug: log a small summary of the upstream response
        try {
          const preview = JSON.stringify({ id: zhipuResp.id, choices: (zhipuResp.choices || []).map((c: any) => ({ finish_reason: c.finish_reason })) });
          app.log.debug({ preview: preview.slice(0, 1000) }, 'Zhipu non-stream response summary');
        } catch (err) {
          /* ignore */
        }

        // Build a normalized OpenAI-like response so clients receive consistent shape.
        const normalizedChoices = (zhipuResp.choices || []).map((c: any, idx: number) => {
          const content = extractChoiceContent(c);
          app.log.debug({ idx, extractedLength: content?.length ?? 0 }, 'Normalized choice extraction');
          return {
            index: idx,
            message: { role: 'assistant', content },
            finish_reason: c.finish_reason ?? null,
          };
        });

        const openaiResp = {
          id: zhipuResp.id,
          object: 'chat.completion',
          created: zhipuResp.created,
          model: requestedModel, // Return the model name the client requested
          choices: normalizedChoices,
        };

        // If no content was extracted, log a warning with full upstream preview to help the user
        if (normalizedChoices.every((c: any) => !c.message.content)) {
          try {
            app.log.warn({ upstream: JSON.stringify(zhipuResp).slice(0, 2000) }, 'No assistant content could be extracted from Zhipu response');
          } catch (err) {
            app.log.warn('No assistant content could be extracted from Zhipu response (unserializable)');
          }
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
      // Accumulate content from the first choice using same extraction logic as above
      const accumulatedContent = zhipuResp.choices && zhipuResp.choices.length
        ? zhipuResp.choices.map((c: any, idx: number) => {
            const piece = extractChoiceContent(c);
            app.log.debug({ idx, pieceLength: piece.length }, 'Streaming: extracted piece length');
            return piece;
          }).join('')
        : '';

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

      // 2. Send content chunks
      for (const piece of chunkText(accumulatedContent, 32)) {
        const contentChunk = { ...baseChunk, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] };
        reply.raw.write(`data: ${JSON.stringify(contentChunk)}\n\n`);
      }

      // 3. Send finish chunk
      const finishReason = zhipuResp.choices?.[0]?.finish_reason ?? 'stop';
      const finishChunk = { ...baseChunk, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] };
      reply.raw.write(`data: ${JSON.stringify(finishChunk)}\n\n`);

      // 4. Send DONE signal
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
    } catch (error: any) {
      app.log.error(error, 'Error during Zhipu stream simulation');
      // If headers are not sent, we can send a proper error. Otherwise, just end the stream.
      if (!reply.raw.headersSent) {
        reply.code(502).headers(CORS_HEADERS).send({ error: 'Upstream API error', detail: error.message });
      } else {
        reply.raw.end();
      }
    }
  });
}
