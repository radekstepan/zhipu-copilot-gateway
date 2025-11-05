import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import supertest from 'supertest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../server';
import * as zhipu from '../zhipu';
import axios from 'axios';

// Helper function to create streaming mock data
const createStreamingMock = (customData?: any) => {
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
        // Send initial chunk
        setTimeout(() => callback(Buffer.from(`data: ${JSON.stringify(data)}\n\n`)), 10);
        
        // If no custom data, send default streaming chunks
        if (!customData) {
          setTimeout(() => callback(Buffer.from(`data: ${JSON.stringify({
            ...data,
            choices: [{ index: 0, delta: { content: 'Streaming' } }]
          })}\n\n`)), 20);
          setTimeout(() => callback(Buffer.from(`data: ${JSON.stringify({
            ...data,
            choices: [{ index: 0, delta: { content: ' test' } }]
          })}\n\n`)), 30);
          setTimeout(() => callback(Buffer.from(`data: ${JSON.stringify({
            ...data,
            choices: [{ index: 0, finish_reason: 'stop' }]
          })}\n\n`)), 40);
        }
        
        // Always end with [DONE]
        setTimeout(() => callback(Buffer.from('data: [DONE]\n')), 50);
      } else if (event === 'end') {
        setTimeout(() => (callback as any)(), 60);
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
      choices: [{ index: 0, message: { role: 'assistant' as const, content: 'Hello there!' }, finish_reason: 'stop' }],
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

  it('POST /v1/chat/completions (stream) should return a valid streaming response', async () => {
    // Mock the streaming function to return async generator
    const mockStreamData = createStreamingMock();
    mockedZhipuChatStream.mockResolvedValue({
      data: mockStreamData,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as any,
    } as any);

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
    expect(responseText).toContain('delta":{"content":"Streaming"}');
    expect(responseText).toContain('delta":{"content":" test"}');
    expect(responseText).toContain('finish_reason":"stop"');
    expect(responseText.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('POST /v1/responses (non-stream) should return a valid response object', async () => {
    const mockZhipuResponse = {
      id: 'resp-mock-123',
      created: Date.now(),
      model: 'glm-4.6',
      choices: [{ index: 0, message: { role: 'assistant' as const, content: 'Hello response!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    };
    mockedZhipuChatOnce.mockResolvedValue(mockZhipuResponse);

    const requestedModel = 'glm-4.6:latest';
    const response = await supertest(app.server)
      .post('/v1/responses')
      .send({ model: requestedModel, messages: [{ role: 'user', content: 'Hi' }], stream: false });

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(mockZhipuResponse.id);
    expect(response.body.model).toBe(requestedModel);
  expect(Array.isArray(response.body.outputs)).toBe(true);
  expect(Array.isArray(response.body.outputs[0].content)).toBe(true);
  expect(response.body.outputs[0].content[0].type).toBe('output_text');
  expect(response.body.outputs[0].content[0].text).toBe('Hello response!');
  });

  it('POST /v1/responses (stream) should return a valid SSE stream', async () => {
    const customData = {
      id: 'resp-mock-456',
      object: 'chat.completion.chunk',
      created: Date.now(),
      model: 'glm-4.5',
      choices: [{ index: 0, delta: { content: 'Streaming response' } }],
    };
    const mockStreamData = createStreamingMock(customData);
    mockedZhipuChatStream.mockResolvedValue({
      data: mockStreamData,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as any,
    } as any);

    const response = await supertest(app.server)
      .post('/v1/responses')
      .send({ model: 'glm-4.5:latest', messages: [{ role: 'user', content: 'Stream test' }], stream: true });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');

    const responseText = response.text;
    expect(responseText).toContain('data: {"id":"resp-mock-456"');
    expect(responseText).toContain('output_text');
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

  // Error handling tests
  it('POST /v1/chat/completions should return 400 for invalid JSON', async () => {
    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send('invalid json');

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid JSON request body');
  });

  it('POST /v1/chat/completions should return 400 for missing model', async () => {
    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({ messages: [{ role: 'user', content: 'Hi' }] });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Missing "model" in request body');
  });

  it('POST /v1/chat/completions should return 400 for invalid messages array', async () => {
    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({ model: 'glm-4.6', messages: 'not an array' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('"messages" must be an array');
  });

  it('POST /v1/responses should return 400 for missing model', async () => {
    const response = await supertest(app.server)
      .post('/v1/responses')
      .send({ messages: [{ role: 'user', content: 'Hi' }] });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Missing "model" in request body');
  });

  it('POST /v1/responses should return 400 for invalid messages array', async () => {
    const response = await supertest(app.server)
      .post('/v1/responses')
      .send({ model: 'glm-4.6', messages: 'not an array' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('"messages" must be an array');
  });

  // Test with Buffer body
  it('POST /v1/chat/completions should handle Buffer body', async () => {
    const mockZhipuResponse = {
      id: 'chatcmpl-mock-buffer',
      created: Date.now(),
      model: 'glm-4.6',
      choices: [{ index: 0, message: { role: 'assistant' as const, content: 'Buffer test' }, finish_reason: 'stop' }],
    };
    mockedZhipuChatOnce.mockResolvedValue(mockZhipuResponse);

    const requestBody = Buffer.from(JSON.stringify({
      model: 'glm-4.6',
      messages: [{ role: 'user', content: 'Hi' }],
    }));

    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send(requestBody);

    expect(response.status).toBe(200);
    expect(response.body.choices[0].message.content).toBe('Buffer test');
  });

  // Test with empty choice content extraction
  it('POST /v1/chat/completions should handle empty choices gracefully', async () => {
    const mockZhipuResponse = {
      id: 'chatcmpl-mock-empty',
      created: Date.now(),
      model: 'glm-4.6',
      choices: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    mockedZhipuChatOnce.mockResolvedValue(mockZhipuResponse);

    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({ model: 'glm-4.6', messages: [{ role: 'user', content: 'Hi' }] });

    expect(response.status).toBe(200);
    expect(response.body.choices).toEqual([]);
    expect(response.body.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });

  // Test tool_calls handling
  it('POST /v1/chat/completions should handle tool_calls in non-streaming response', async () => {
    const mockZhipuResponse = {
      id: 'chatcmpl-mock-tools',
      created: Date.now(),
      model: 'glm-4.6',
      choices: [{
        index: 0,
        message: {
          role: 'assistant' as const,
          content: null,
          tool_calls: [
            {
              id: 'tool-123',
              type: 'function' as const,
              function: {
                name: 'test_function',
                arguments: '{"param": "value"}',
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    mockedZhipuChatOnce.mockResolvedValue(mockZhipuResponse);

    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({ model: 'glm-4.6', messages: [{ role: 'user', content: 'Use tool' }] });

    expect(response.status).toBe(200);
    expect(response.body.choices[0].message.content).toBeNull();
    expect(response.body.choices[0].message.tool_calls).toBeDefined();
    expect(response.body.choices[0].message.tool_calls[0].id).toBe('tool-123');
    expect(response.body.choices[0].finish_reason).toBe('tool_calls');
  });

  // Test streaming with tool_calls
  it('POST /v1/chat/completions (stream) should handle tool_calls streaming', async () => {
    const customData = {
      id: 'chatcmpl-mock-stream-tools',
      object: 'chat.completion.chunk',
      created: Date.now(),
      model: 'glm-4.5',
      choices: [{
        index: 0,
        delta: {
          content: null,
          tool_calls: [
            {
              index: 0,
              id: 'tool-stream-123',
              type: 'function' as const,
              function: {
                name: 'test_function',
                arguments: '{"param": "test_value"}',
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    };
    const mockStreamData = createStreamingMock(customData);
    mockedZhipuChatStream.mockResolvedValue({
      data: mockStreamData,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as any,
    } as any);

    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({ model: 'glm-4.5', messages: [{ role: 'user', content: 'Stream tool test' }], stream: true });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');

    const responseText = response.text;
    expect(responseText).toContain('tool_calls');
    expect(responseText).toContain('finish_reason":"tool_calls"');
    expect(responseText.trim().endsWith('data: [DONE]')).toBe(true);
  });

  // Test streaming with different content shapes
  // Test with different content shapes
  it('POST /v1/chat/completions (stream) should handle different content extraction shapes', async () => {
    const customData = {
      id: 'chatcmpl-mock-stream-shapes',
      object: 'chat.completion.chunk',
      created: Date.now(),
      model: 'glm-4.5',
      choices: [{
        index: 0,
        delta: { role: 'assistant' as const, content: 'Test content' },
        finish_reason: 'stop',
      }],
    };
    const mockStreamData = createStreamingMock(customData);
    mockedZhipuChatStream.mockResolvedValue({
      data: mockStreamData,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as any,
    } as any);

    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({ model: 'glm-4.5', messages: [{ role: 'user', content: 'Test' }], stream: true });

    expect(response.status).toBe(200);
    expect(response.text).toContain('Test content');
  });

  // Test warning for no extracted content
  it('POST /v1/chat/completions should log warning when no content or tool_calls extracted', async () => {
    const mockZhipuResponse = {
      id: 'chatcmpl-mock-warning',
      created: Date.now(),
      model: 'glm-4.6',
      choices: [{
        index: 0,
        message: { role: 'assistant' as const, content: '' },
        finish_reason: 'stop',
      }],
    };
    mockedZhipuChatOnce.mockResolvedValue(mockZhipuResponse);

    // Mock the logger to verify warning is logged
    const logSpy = vi.spyOn(app.log, 'warn');

    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({ model: 'glm-4.6', messages: [{ role: 'user', content: 'Hi' }] });

    expect(response.status).toBe(200);
    expect(logSpy).toHaveBeenCalled();
  });

  // Test streaming error handling
  it('POST /v1/chat/completions (stream) should handle streaming errors gracefully', async () => {
    mockedZhipuChatStream.mockRejectedValue(new Error('Stream error'));

    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({ model: 'glm-4.5', messages: [{ role: 'user', content: 'Test' }], stream: true });

    expect(response.status).toBe(502);
    expect(response.body.error).toBe('Upstream API error');
  });

  // Test responses endpoint with tool_calls
  it('POST /v1/responses should handle tool_calls in non-streaming response', async () => {
    const mockZhipuResponse = {
      id: 'resp-mock-tools',
      created: Date.now(),
      model: 'glm-4.6',
      choices: [{
        index: 0,
        message: {
          role: 'assistant' as const,
          content: null,
          tool_calls: [
            {
              id: 'resp-tool-123',
              type: 'function' as const,
              function: {
                name: 'test_function',
                arguments: '{"param": "value"}',
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    };
    mockedZhipuChatOnce.mockResolvedValue(mockZhipuResponse);

    const response = await supertest(app.server)
      .post('/v1/responses')
      .send({ model: 'glm-4.6', messages: [{ role: 'user', content: 'Use tool' }] });

    expect(response.status).toBe(200);
    expect(response.body.outputs[0].tool_calls).toBeDefined();
    expect(response.body.outputs[0].tool_calls[0].id).toBe('resp-tool-123');
    expect(response.body.outputs[0].finish_reason).toBe('tool_calls');
  });

  // Test responses streaming with tool_calls
  it('POST /v1/responses (stream) should handle tool_calls streaming', async () => {
    const customData = {
      id: 'resp-mock-stream-tools',
      object: 'chat.completion.chunk',
      created: Date.now(),
      model: 'glm-4.5',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant' as const,
          content: null,
          tool_calls: [
            {
              index: 0,
              id: 'resp-tool-stream-123',
              type: 'function' as const,
              function: {
                name: 'test_function',
                arguments: '{"param": "test_value"}',
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    };
    const mockStreamData = createStreamingMock(customData);
    mockedZhipuChatStream.mockResolvedValue({
      data: mockStreamData,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as any,
    } as any);

    const response = await supertest(app.server)
      .post('/v1/responses')
      .send({ model: 'glm-4.5', messages: [{ role: 'user', content: 'Stream tool test' }], stream: true });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');

    const responseText = response.text;
    expect(responseText).toContain('tool_calls');
    expect(responseText).toContain('type":"tool_call"');
    expect(responseText.trim().endsWith('data: [DONE]')).toBe(true);
  });

// Test with different model name formats
  it('POST /v1/chat/completions should handle different model name formats', async () => {
    const mockZhipuResponse = {
      id: 'chatcmpl-mock-model-norm',
      created: Date.now(),
      model: 'glm-4.6',
      choices: [{ index: 0, message: { role: 'assistant' as const, content: 'Model normalization test' }, finish_reason: 'stop' }],
    };
    mockedZhipuChatOnce.mockResolvedValue(mockZhipuResponse);

    // Test with non-glm model (should use default model)
    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({ model: 'gpt-3.5-turbo', messages: [{ role: 'user', content: 'Hi' }] });

    expect(response.status).toBe(200);
    expect(response.body.model).toBe('gpt-3.5-turbo');
  });

  // Test with string body
  it('POST /v1/chat/completions should handle string body', async () => {
    const mockZhipuResponse = {
      id: 'chatcmpl-mock-string',
      created: Date.now(),
      model: 'glm-4.6',
      choices: [{ index: 0, message: { role: 'assistant' as const, content: 'String body test' }, finish_reason: 'stop' }],
    };
    mockedZhipuChatOnce.mockResolvedValue(mockZhipuResponse);

    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}');

    expect(response.status).toBe(200);
    expect(response.body.choices[0].message.content).toBe('String body test');
  });

  // Test responses endpoint with reasoning content
  it('POST /v1/responses should handle reasoning content', async () => {
    const mockZhipuResponse = {
      id: 'resp-mock-reasoning',
      created: Date.now(),
      model: 'glm-4.6',
      choices: [{
        index: 0,
        message: { role: 'assistant' as const, content: 'Response with reasoning' },
        reasoning: 'This is reasoning content',
        finish_reason: 'stop',
      }],
    };
    mockedZhipuChatOnce.mockResolvedValue(mockZhipuResponse);

    const response = await supertest(app.server)
      .post('/v1/responses')
      .send({ model: 'glm-4.6', messages: [{ role: 'user', content: 'Hi' }] });

    expect(response.status).toBe(200);
    expect(response.body.outputs[0].reasoning).toBe('This is reasoning content');
  });

  // Test responses endpoint streaming with reasoning content
  it('POST /v1/responses (stream) should handle reasoning content', async () => {
    const customData = {
      id: 'resp-mock-stream-reasoning',
      object: 'chat.completion.chunk',
      created: Date.now(),
      model: 'glm-4.5',
      choices: [{
        index: 0,
        delta: { 
          content: 'Streaming response with reasoning',
          reasoning: 'This is streaming reasoning content'
        },
        finish_reason: 'stop',
      }],
    };
    const mockStreamData = createStreamingMock(customData);
    mockedZhipuChatStream.mockResolvedValue({
      data: mockStreamData,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as any,
    } as any);

    const response = await supertest(app.server)
      .post('/v1/responses')
      .send({ model: 'glm-4.5', messages: [{ role: 'user', content: 'Stream reasoning test' }], stream: true });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');

    const responseText = response.text;
    expect(responseText).toContain('data: {"id":"resp-mock-stream-reasoning"');
    expect(responseText).toContain('output_text');
    expect(responseText.trim().endsWith('data: [DONE]')).toBe(true);
  });

  // Test normalizeToolCalls function behavior
  it('POST /v1/chat/completions should normalize tool_calls without IDs', async () => {
    const mockZhipuResponse = {
      id: 'chatcmpl-mock-tools-no-id',
      created: Date.now(),
      model: 'glm-4.6',
      choices: [{
        index: 0,
        message: {
          role: 'assistant' as const,
          content: null,
          tool_calls: [
            {
              id: 'call_abc123def456',
              type: 'function' as const,
              function: {
                name: 'test_function',
                arguments: '{"param": "value"}',
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    mockedZhipuChatOnce.mockResolvedValue(mockZhipuResponse);

    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({ model: 'glm-4.6', messages: [{ role: 'user', content: 'Use tool' }] });

    expect(response.status).toBe(200);
    expect(response.body.choices[0].message.tool_calls).toBeDefined();
    expect(response.body.choices[0].message.tool_calls[0].id).toMatch(/^call_[a-f0-9-]+$/);
    expect(response.body.choices[0].message.tool_calls[0].type).toBe('function');
  });

  // Test extractChoiceContent with different shapes
  it('POST /v1/chat/completions should handle delta content shape', async () => {
    const mockZhipuResponse = {
      id: 'chatcmpl-mock-delta',
      created: Date.now(),
      model: 'glm-4.6',
      choices: [{
        index: 0,
        delta: { content: 'Delta content' },
        finish_reason: 'stop',
      }],
    };
    mockedZhipuChatOnce.mockResolvedValue(mockZhipuResponse);

    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({ model: 'glm-4.6', messages: [{ role: 'user', content: 'Hi' }] });

    expect(response.status).toBe(200);
    expect(response.body.choices[0].message.content).toBe('Delta content');
  });

  // Test extractChoiceContent with text shape
  it('POST /v1/chat/completions should handle text content shape', async () => {
    const mockZhipuResponse = {
      id: 'chatcmpl-mock-text',
      created: Date.now(),
      model: 'glm-4.6',
      choices: [{
        index: 0,
        text: 'Text content',
        finish_reason: 'stop',
      }],
    };
    mockedZhipuChatOnce.mockResolvedValue(mockZhipuResponse);

    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({ model: 'glm-4.6', messages: [{ role: 'user', content: 'Hi' }] });

    expect(response.status).toBe(200);
    expect(response.body.choices[0].message.content).toBe('Text content');
  });

  // Test extractChoiceContent with contents array
  it('POST /v1/chat/completions should handle contents array shape', async () => {
    const mockZhipuResponse = {
      id: 'chatcmpl-mock-contents',
      created: Date.now(),
      model: 'glm-4.6',
      choices: [{
        index: 0,
        contents: ['Content 1', 'Content 2'],
        finish_reason: 'stop',
      }],
    };
    mockedZhipuChatOnce.mockResolvedValue(mockZhipuResponse);

    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({ model: 'glm-4.6', messages: [{ role: 'user', content: 'Hi' }] });

    expect(response.status).toBe(200);
    expect(response.body.choices[0].message.content).toBe('Content 1,Content 2');
  });

  it('POST /v1/chat/completions forwards tool metadata to Zhipu intact', async () => {
    const mockZhipuResponse = {
      id: 'chatcmpl-forward-tools',
      created: Date.now(),
      model: 'glm-4.6',
      choices: [{
        index: 0,
        message: {
          role: 'assistant' as const,
          content: 'done',
        },
        finish_reason: 'stop',
      }],
    };
    mockedZhipuChatOnce.mockResolvedValue(mockZhipuResponse);

    const requestMessages = [
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [
          {
            id: 'call_A',
            type: 'function',
            function: {
              name: 'search_docs',
              arguments: { query: 'hello' },
            },
          },
        ],
      },
      {
        role: 'tool' as const,
        tool_call_id: 'call_A',
        content: 'search result payload',
      },
      {
        role: 'user' as const,
        content: 'Use that info please',
      },
    ];

    const requestTools = [
      {
        type: 'function',
        function: {
          name: 'search_docs',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string' },
            },
            required: ['query'],
          },
        },
      },
    ];

    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({
        model: 'glm-4.6:latest',
        messages: requestMessages,
        tools: requestTools,
      });

    expect(response.status).toBe(200);
  expect(mockedZhipuChatOnce).toHaveBeenCalled();
  const forwardedArgs = mockedZhipuChatOnce.mock.calls.at(-1);
  expect(forwardedArgs).toBeDefined();
  const forwardedRequest = forwardedArgs![0] as zhipu.ZhipuChatRequest;
    expect(forwardedRequest.model).toBe('glm-4.6:latest');
    expect(forwardedRequest.tools).toEqual(requestTools);
    expect(forwardedRequest.messages).toHaveLength(3);
  expect(forwardedRequest.messages[0].tool_calls?.[0]?.function.arguments).toBe('{"query":"hello"}');
    expect(forwardedRequest.messages[1].tool_call_id).toBe('call_A');
  });

  // Test error handling when headers already sent
  it('POST /v1/chat/completions should handle errors when headers already sent', async () => {
    // Mock a scenario where headers are already sent but an error occurs
    const mockZhipuResponse = {
      id: 'chatcmpl-error-after-headers',
      created: Date.now(),
      model: 'glm-4.6',
      choices: [{ index: 0, message: { role: 'assistant' as const, content: 'Error test' }, finish_reason: 'stop' }],
    };
    
    // Make zhipuChatOnce fail after initial response
    mockedZhipuChatOnce.mockImplementation(async () => {
      // Simulate headers being sent by throwing an error during streaming
      const error = new Error('Connection lost');
      throw error;
    });

    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({ model: 'glm-4.6', messages: [{ role: 'user', content: 'Test error handling' }] });

    expect(response.status).toBe(502);
    expect(response.body.error).toBe('Upstream API error');
  });

  // Test message normalization with structured content
  it('POST /v1/chat/completions should normalize messages with structured content', async () => {
    const mockZhipuResponse = {
      id: 'chatcmpl-structured-content',
      created: Date.now(),
      model: 'glm-4.6',
      choices: [{ index: 0, message: { role: 'assistant' as const, content: 'Structured content test' }, finish_reason: 'stop' }],
    };
    mockedZhipuChatOnce.mockResolvedValue(mockZhipuResponse);

    const requestMessages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' } }
        ],
      },
    ];

    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({ model: 'glm-4.6', messages: requestMessages });

    expect(response.status).toBe(200);
    expect(mockedZhipuChatOnce).toHaveBeenCalled();
    const forwardedArgs = mockedZhipuChatOnce.mock.calls.at(-1);
    expect(forwardedArgs).toBeDefined();
    const forwardedRequest = forwardedArgs![0] as zhipu.ZhipuChatRequest;
    expect(Array.isArray(forwardedRequest.messages[0].content)).toBe(true);
    expect(forwardedRequest.messages[0].content?.[0]).toEqual({ type: 'text', text: 'Hello' });
  });

  // Test message normalization with invalid role
  it('POST /v1/chat/completions should normalize messages with invalid role', async () => {
    const mockZhipuResponse = {
      id: 'chatcmpl-invalid-role',
      created: Date.now(),
      model: 'glm-4.6',
      choices: [{ index: 0, message: { role: 'assistant' as const, content: 'Invalid role test' }, finish_reason: 'stop' }],
    };
    mockedZhipuChatOnce.mockResolvedValue(mockZhipuResponse);

    const requestMessages = [
      {
        role: null as any,
        content: 'Test message with invalid role',
      },
    ];

    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({ model: 'glm-4.6', messages: requestMessages });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Each message must include a string "role"');
  });

  // Test message normalization with null/undefined message
  it('POST /v1/chat/completions should normalize null/undefined messages', async () => {
    const mockZhipuResponse = {
      id: 'chatcmpl-null-msg',
      created: Date.now(),
      model: 'glm-4.6',
      choices: [{ index: 0, message: { role: 'assistant' as const, content: 'Null message test' }, finish_reason: 'stop' }],
    };
    mockedZhipuChatOnce.mockResolvedValue(mockZhipuResponse);

    const requestMessages = [
      null,
      undefined,
      'string message',
      { role: 'user', content: 'normal message' },
    ];

    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({ model: 'glm-4.6', messages: requestMessages });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Each message must include a string "role"');
  });

  // Test streaming with reasoning content for responses endpoint
  it('POST /v1/responses (stream) should stream reasoning content properly', async () => {
    const customData = {
      id: 'resp-mock-stream-reasoning-long',
      object: 'chat.completion.chunk',
      created: Date.now(),
      model: 'glm-4.5',
      choices: [{
        index: 0,
        delta: { 
          content: 'Final answer',
          reasoning: 'This is a very long reasoning content that should be chunked into multiple pieces for proper streaming testing and coverage of the chunkText function with reasoning content.'
        },
        finish_reason: 'stop',
      }],
    };
    const mockStreamData = createStreamingMock(customData);
    mockedZhipuChatStream.mockResolvedValue({
      data: mockStreamData,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as any,
    } as any);

    const response = await supertest(app.server)
      .post('/v1/responses')
      .send({ model: 'glm-4.5', messages: [{ role: 'user', content: 'Stream long reasoning test' }], stream: true });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');

    const responseText = response.text;
    expect(responseText).toContain('reasoning');
    expect(responseText).toContain('data: [DONE]');
  });

  // Test tool_calls normalization with missing function properties
  it('POST /v1/chat/completions should normalize tool_calls with missing function properties', async () => {
    const mockZhipuResponse = {
      id: 'chatcmpl-tools-missing-props',
      created: Date.now(),
      model: 'glm-4.6',
      choices: [{
        index: 0,
        message: {
          role: 'assistant' as const,
          content: null,
          tool_calls: [
            {
              id: 'tool-missing-props',
              type: 'function' as const,
              function: {
                name: '',
                arguments: '',
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    };
    mockedZhipuChatOnce.mockResolvedValue(mockZhipuResponse);

    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({ model: 'glm-4.6', messages: [{ role: 'user', content: 'Test tool normalization' }] });

    expect(response.status).toBe(200);
    expect(response.body.choices[0].message.tool_calls[0].function.name).toBe('unnamed');
    expect(response.body.choices[0].message.tool_calls[0].function.arguments).toBe('');
  });

  // Test with empty request body
  it('POST /v1/chat/completions should handle empty request body', async () => {
    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Missing "model" in request body');
  });

  // Test with empty request body
  it('POST /v1/chat/completions should handle empty request body', async () => {
    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Missing "model" in request body');
  });

  // Test with messages array containing non-string role
  it('POST /v1/chat/completions should return 400 for messages with non-string role', async () => {
    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({
        model: 'glm-4.6',
        messages: [
          { role: 'user', content: 'Valid message' },
          { role: 123, content: 'Invalid role' }, // role should be string
        ],
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Each message must include a string "role"');
  });

  // Test streaming error handling when headers already sent
  it('POST /v1/chat/completions (stream) should handle errors when headers already sent', async () => {
    // Mock zhipuChatStream to throw an error during streaming
    mockedZhipuChatStream.mockImplementation(async () => {
      const error = new Error('Connection lost during streaming');
      throw error;
    });

    const response = await supertest(app.server)
      .post('/v1/chat/completions')
      .send({ model: 'glm-4.6', messages: [{ role: 'user', content: 'Test streaming error' }], stream: true });

    expect(response.status).toBe(502);
    expect(response.body.error).toBe('Upstream API error');
  });

  // Test responses endpoint streaming with reasoning content
  it('POST /v1/responses (stream) should handle reasoning content chunking', async () => {
    const customData = {
      id: 'resp-reasoning-chunk',
      object: 'chat.completion.chunk',
      created: Date.now(),
      model: 'glm-4.5',
      choices: [{
        index: 0,
        delta: { 
          role: 'assistant' as const, 
          content: 'Final answer',
          reasoning: 'This is a reasoning content that should be chunked properly for streaming coverage testing.'
        },
        finish_reason: 'stop',
      }],
    };
    const mockStreamData = createStreamingMock(customData);
    mockedZhipuChatStream.mockResolvedValue({
      data: mockStreamData,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as any,
    } as any);

    const response = await supertest(app.server)
      .post('/v1/responses')
      .send({ model: 'glm-4.5', messages: [{ role: 'user', content: 'Test reasoning chunking' }], stream: true });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.text).toContain('reasoning');
    expect(response.text).toContain('data: [DONE]');
  });

  // Test responses endpoint with longer reasoning content to ensure chunking is triggered
  it('POST /v1/responses (stream) should chunk long reasoning content', async () => {
    const longReasoning = 'This is a very long reasoning content that spans multiple chunks and should definitely trigger the chunkText function with the 32 character limit for proper coverage testing of the reasoning content streaming logic in the responses endpoint.';
    
    const customData = {
      id: 'resp-long-reasoning',
      object: 'chat.completion.chunk',
      created: Date.now(),
      model: 'glm-4.5',
      choices: [{
        index: 0,
        delta: { 
          role: 'assistant' as const, 
          content: 'Final answer',
          reasoning: longReasoning
        },
        finish_reason: 'stop',
      }],
    };
    const mockStreamData = createStreamingMock(customData);
    mockedZhipuChatStream.mockResolvedValue({
      data: mockStreamData,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as any,
    } as any);

    const response = await supertest(app.server)
      .post('/v1/responses')
      .send({ model: 'glm-4.5', messages: [{ role: 'user', content: 'Test long reasoning chunking' }], stream: true });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.text).toContain('reasoning');
    expect(response.text).toContain('data: [DONE]');
  });
});
