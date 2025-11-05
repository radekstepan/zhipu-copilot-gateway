import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import supertest from 'supertest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../server';
import * as zhipu from '../zhipu';

// Mock the zhipu module
vi.mock('../zhipu', async (importOriginal) => {
  const original = await importOriginal<typeof zhipu>();
  return {
    ...original,
    zhipuChatOnce: vi.fn(),
  };
});
const mockedZhipuChatOnce = vi.mocked(zhipu.zhipuChatOnce);

describe('Chat Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // Set a dummy API key to prevent config initialization from failing
    process.env.ZHIPUAI_API_KEY = 'dummy-test-key';
    app = buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /v1/chat/completions (non-stream) should return a valid completion', async () => {
    const mockZhipuResponse = {
      id: 'chatcmpl-mock-123',
      created: Date.now(),
      model: 'glm-4.6',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello there!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    mockedZhipuChatOnce.mockResolvedValue(mockZhipuResponse);

    const requestedModel = 'glm-4.6:latest';
    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({
        model: requestedModel,
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false,
      });

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(mockZhipuResponse.id);
    expect(response.body.model).toBe(requestedModel); // Should reflect the user's request
    expect(response.body.choices[0].message.content).toBe('Hello there!');
    expect(response.body.object).toBe('chat.completion');
  });

  it('POST /v1/chat/completions (stream) should return a valid SSE stream', async () => {
    const mockZhipuResponse = {
      id: 'chatcmpl-mock-456',
      created: Date.now(),
      model: 'glm-4.5',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Streaming test' }, finish_reason: 'stop' }],
    };
    mockedZhipuChatOnce.mockResolvedValue(mockZhipuResponse);

    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({
        model: 'glm-4.5:latest',
        messages: [{ role: 'user', content: 'Stream test' }],
        stream: true,
      });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');

    const responseText = response.text;
    expect(responseText).toContain('data: {"id":"chatcmpl-mock-456"');
    expect(responseText).toContain('delta":{"role":"assistant"}');
    expect(responseText).toContain('delta":{"content":"Streaming test"}');
    expect(responseText).toContain('finish_reason":"stop"');
    expect(responseText.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('POST /v1/chat/completions should handle Zhipu API errors gracefully', async () => {
    mockedZhipuChatOnce.mockRejectedValue(new Error('Zhipu API is down'));

    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({
        model: 'glm-4.6:latest',
        messages: [{ role: 'user', content: 'Hi' }],
      });

    expect(response.status).toBe(502);
    expect(response.body.error).toBe('Upstream API error');
    expect(response.body.detail).toBe('Zhipu API is down');
  });
});
