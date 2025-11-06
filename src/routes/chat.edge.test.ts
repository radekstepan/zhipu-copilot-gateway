import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import supertest from 'supertest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../server';
import * as zhipu from '../zhipu';
import { AxiosResponse, InternalAxiosRequestConfig } from 'axios';

// Helper function to create streaming mock data
const createStreamingMock = (customData?: Record<string, unknown>) => {
  const defaultData = {
    id: 'chatcmpl-mock-456',
    object: 'chat.completion.chunk',
    created: Date.now(),
    model: 'glm-4.5',
    choices: [{ index: 0, delta: { role: 'assistant' } }],
  };
  
  const data = customData || defaultData;
  
  return {
    on: (event: string, callback: (chunk: Buffer) => void) => {
      if (event === 'data') {
        // Simulate async data emission
        setTimeout(() => {
          callback(Buffer.from(`data: ${JSON.stringify(data)}\n\n`));
        }, 10);
      } else if (event === 'end') {
        setTimeout(() => {
          callback(Buffer.from('data: [DONE]\n\n'));
        }, 20);
      }
    },
  };
};

// Mock the zhipu module
vi.mock('../zhipu', () => ({
  zhipuChatOnce: vi.fn(),
  zhipuChatStream: vi.fn(),
  normalizeModelName: vi.fn((model: string) => model),
}));
const mockedZhipuChatOnce = vi.mocked(zhipu.zhipuChatOnce);
const mockedZhipuChatStream = vi.mocked(zhipu.zhipuChatStream);

describe('Chat Routes - edge cases', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.ZHIPUAI_API_KEY = 'dummy-test-key';
    app = buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 400 for invalid JSON body', async () => {
    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .set('Content-Type', 'application/json')
      .send('not-json');

    expect(response.status).toBe(400);
    // Fastify may return a generic Bad Request or our custom message depending on parser behavior.
    expect(response.body).toHaveProperty('error');
  });

  it('returns 400 when model is missing', async () => {
    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({ messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Missing "model" in request body');
  });

  it('returns 400 when messages is not an array', async () => {
    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({ model: 'glm-4.6:latest', messages: 'nope' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('"messages" must be an array');
  });

  it('extractChoiceContent handles delta, text, content and contents array', async () => {
    // delta
  mockedZhipuChatOnce.mockResolvedValueOnce({ id: 'd1', created: Date.now(), model: 'glm', choices: [{ delta: { content: 'delta-content' } }] } as zhipu.ZhipuChatNonStreamResp);
    let resp = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({ model: 'glm-4.6:latest', messages: [{ role: 'user', content: 'h' }], stream: false });
    expect(resp.status).toBe(200);
    expect(resp.body.choices[0].message.content).toBe('delta-content');

    // text
  mockedZhipuChatOnce.mockResolvedValueOnce({ id: 't1', created: Date.now(), model: 'glm', choices: [{ index: 0, text: 'text-content' }] } as zhipu.ZhipuChatNonStreamResp);
    resp = await supertest(app.server).post('/v1/chat/completions').send({ model: 'glm-4.6:latest', messages: [{ role: 'user', content: 'h' }], stream: false });
    expect(resp.status).toBe(200);
    expect(resp.body.choices[0].message.content).toBe('text-content');

    // content
  mockedZhipuChatOnce.mockResolvedValueOnce({ id: 'c1', created: Date.now(), model: 'glm', choices: [{ index: 0, content: 'content-field' }] } as zhipu.ZhipuChatNonStreamResp);
    resp = await supertest(app.server).post('/v1/chat/completions').send({ model: 'glm-4.6:latest', messages: [{ role: 'user', content: 'h' }], stream: false });
    expect(resp.status).toBe(200);
    expect(resp.body.choices[0].message.content).toBe('content-field');

    // contents array
  mockedZhipuChatOnce.mockResolvedValueOnce({ id: 'a1', created: Date.now(), model: 'glm', choices: [{ index: 0, contents: ['a', 'b'] }] } as zhipu.ZhipuChatNonStreamResp);
    resp = await supertest(app.server).post('/v1/chat/completions').send({ model: 'glm-4.6:latest', messages: [{ role: 'user', content: 'h' }], stream: false });
    expect(resp.status).toBe(200);
    expect(resp.body.choices[0].message.content).toBe('a,b');
  });

  it('streams tool_calls correctly in SSE mode', async () => {
    const customData = {
      id: 'stream-tool-1',
      object: 'chat.completion.chunk',
      created: Date.now(),
      model: 'glm',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                id: 't1',
                type: 'tool' as const,
                function: { name: 'fn', arguments: 'ARGUMENTS-STREAM' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };

    const mockStreamData = createStreamingMock(customData);
    mockedZhipuChatStream.mockResolvedValue({
      data: mockStreamData,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as InternalAxiosRequestConfig,
    } as AxiosResponse);

    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({ model: 'glm-4.6:latest', messages: [{ role: 'user', content: 'stream' }], stream: true });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    const text = response.text;
    expect(text).toContain('tool_calls');
    expect(text).toContain('"id":"t1"');
    expect(text).toContain('ARGUMENTS-STREAM');
    expect(text).toContain('finish_reason":"tool_calls"');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
  });
});
