import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { normalizeModelName, zhipuChatOnce, zhipuChatStream, ZhipuChatRequest } from './zhipu';

vi.mock('axios');
vi.mock('./logger', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// Import the mocked logger for verification
import { logger } from './logger';

vi.mock('./config', () => ({
  config: {
    ZHIPUAI_API_KEY: 'test-api-key',
    ZHIPUAI_API_BASE_URL: 'https://api.zhipu.ai/v4',
  },
}));

describe('zhipu utilities', () => {
  beforeEach(() => {
    vi.mocked(axios.post).mockReset();
    vi.clearAllMocks();
  });

  describe('normalizeModelName', () => {
    it('strips suffix after colon', () => {
      expect(normalizeModelName('glm-4.6:latest')).toBe('glm-4.6');
      expect(normalizeModelName('glm-4.6')).toBe('glm-4.6');
      expect(normalizeModelName('')).toBe('');
            // allow nullish values through (keeps behavior consistent)
      expect(normalizeModelName(null as unknown as string)).toBe(null);
      expect(normalizeModelName(undefined as unknown as string)).toBe(undefined);
    });

    it('handles multiple colons', () => {
      expect(normalizeModelName('model:tag:extra')).toBe('model');
    });

    it('handles models without colons', () => {
      expect(normalizeModelName('gpt-4')).toBe('gpt-4');
      expect(normalizeModelName('claude-3-sonnet')).toBe('claude-3-sonnet');
    });

    it('handles edge cases', () => {
      expect(normalizeModelName(':')).toBe('');
      expect(normalizeModelName('model:')).toBe('model');
      expect(normalizeModelName(':tag')).toBe('');
    });
  });

  describe('zhipuChatOnce', () => {
    it('returns axios response data on success', async () => {
      const fakeResp = { data: { id: 'x', created: 1, model: 'glm-4', choices: [] } };
      vi.mocked(axios.post).mockResolvedValueOnce(fakeResp as unknown);

      const req: ZhipuChatRequest = { model: 'glm-4', messages: [{ role: 'user', content: 'hi' }] };
      const res = await zhipuChatOnce(req);

      expect(res).toEqual(fakeResp.data);
      expect(vi.mocked(axios.post)).toHaveBeenCalledWith(
        'https://api.zhipu.ai/v4/chat/completions',
        { ...req, stream: false },
        { headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-api-key' } }
      );
    });

    it('handles response data that cannot be stringified', async () => {
      const circularObj: Record<string, unknown> = {};
      circularObj.self = circularObj;
      const fakeResp = { data: circularObj, status: 200 };
      vi.mocked(axios.post).mockResolvedValueOnce(fakeResp as unknown);

      const req: ZhipuChatRequest = { model: 'glm-4', messages: [{ role: 'user', content: 'hi' }] };
      const res = await zhipuChatOnce(req);

      expect(res).toEqual(circularObj);
    });

    it('handles string response data', async () => {
      const fakeResp = { data: 'string response', status: 200 };
      vi.mocked(axios.post).mockResolvedValueOnce(fakeResp as unknown);

      const req: ZhipuChatRequest = { model: 'glm-4', messages: [{ role: 'user', content: 'hi' }] };
      const res = await zhipuChatOnce(req);

      expect(res).toBe('string response');
    });

    it('throws when axios.post rejects', async () => {
      const err = new Error('boom');
      vi.mocked(axios.post).mockRejectedValueOnce(err);

      const req: ZhipuChatRequest = { model: 'glm-4', messages: [{ role: 'user', content: 'hi' }] };
      await expect(zhipuChatOnce(req)).rejects.toThrow('boom');
    });

    it('handles axios error with response data', async () => {
      const axiosError = new Error('API Error') as Error & { response?: { data?: unknown } };
      axiosError.response = { data: { error: 'Invalid request' } };
      vi.mocked(axios.post).mockRejectedValueOnce(axiosError);

      const req: ZhipuChatRequest = { model: 'glm-4', messages: [{ role: 'user', content: 'hi' }] };
      await expect(zhipuChatOnce(req)).rejects.toThrow('API Error');
    });

    it('handles errors without toString method', async () => {
      const errorWithoutToString = { message: 'Custom error' } as Error & { toString?: undefined };
      vi.mocked(axios.post).mockRejectedValueOnce(errorWithoutToString);

      const req: ZhipuChatRequest = { model: 'glm-4', messages: [{ role: 'user', content: 'hi' }] };
      await expect(zhipuChatOnce(req)).rejects.toThrow();
    });

    it('logs error with response data when available', async () => {
      const axiosError = new Error('API failed') as Error & { response?: { data?: unknown } };
      axiosError.response = { data: { error: 'Rate limited' } };
      axiosError.toString = () => 'API failed';
      vi.mocked(axios.post).mockRejectedValueOnce(axiosError);

      const req: ZhipuChatRequest = { model: 'glm-4', messages: [{ role: 'user', content: 'hi' }] };
      
      await expect(zhipuChatOnce(req)).rejects.toThrow('API failed');
      
      // Verify that error logging was called with the right parameters
      expect(logger.error).toHaveBeenCalledWith(
        {
          err: 'API failed',
          response: { error: 'Rate limited' },
          model: 'glm-4'
        },
        'Zhipu API call failed'
      );
    });

    it('logs error without toString method and without response data', async () => {
      const errorWithoutToString = { message: 'Custom error' } as Error & { toString?: undefined };
      // Remove toString method to test the fallback
      vi.mocked(axios.post).mockRejectedValueOnce(errorWithoutToString);

      const req: ZhipuChatRequest = { model: 'glm-4', messages: [{ role: 'user', content: 'hi' }] };
      
      await expect(zhipuChatOnce(req)).rejects.toThrow();
      
      // Verify that error logging was called with String(error) fallback and no response data
      expect(logger.error).toHaveBeenCalledWith(
        {
          err: String(errorWithoutToString),
          response: undefined,
          model: 'glm-4'
        },
        'Zhipu API call failed'
      );
    });

    it('logs error with null error object', async () => {
      vi.mocked(axios.post).mockRejectedValueOnce(null);

      const req: ZhipuChatRequest = { model: 'glm-4', messages: [{ role: 'user', content: 'hi' }] };
      
      // When null is rejected, it should still throw but we need to handle it differently
      try {
        await zhipuChatOnce(req);
        expect.fail('Should have thrown');
      } catch (error) {
        // Verify that error logging was called
        expect(logger.error).toHaveBeenCalledWith(
          {
            err: String(null),
            response: undefined,
            model: 'glm-4'
          },
          'Zhipu API call failed'
        );
      }
    });

    it('passes all request parameters correctly', async () => {
      const fakeResp = { data: { id: 'x', created: 1, model: 'glm-4', choices: [] } };
      vi.mocked(axios.post).mockResolvedValueOnce(fakeResp as unknown);

      const req: ZhipuChatRequest = {
        model: 'glm-4',
        messages: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'Hello' }
        ],
        temperature: 0.7,
        max_tokens: 1000,
        stream: false,
        tools: [{ type: 'function', function: { name: 'test' } }],
        user: 'test-user'
      };
      await zhipuChatOnce(req);

      expect(vi.mocked(axios.post)).toHaveBeenCalledWith(
        'https://api.zhipu.ai/v4/chat/completions',
        { ...req, stream: false },
        { headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-api-key' } }
      );
    });
  });

  describe('zhipuChatStream', () => {
    it('returns axios response for non-streaming requests', async () => {
      const fakeResp = { data: 'response data', status: 200 };
      vi.mocked(axios.post).mockResolvedValueOnce(fakeResp as unknown);
      const req: ZhipuChatRequest = { model: 'glm-4', messages: [{ role: 'user', content: 'hi' }] };
      const res = await zhipuChatStream(req);

      expect(res).toEqual(fakeResp);
      expect(vi.mocked(axios.post)).toHaveBeenCalledWith(
        'https://api.zhipu.ai/v4/chat/completions',
        { ...req, stream: true },
        { 
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-api-key' },
          responseType: 'stream'
        }
      );
    });

    it('throws when axios.post rejects for streaming', async () => {
      const err = new Error('stream error');
      vi.mocked(axios.post).mockRejectedValueOnce(err);

      const req: ZhipuChatRequest = { model: 'glm-4', messages: [{ role: 'user', content: 'hi' }] };
      await expect(zhipuChatStream(req)).rejects.toThrow('stream error');
    });

    it('passes all request parameters for streaming', async () => {
      const fakeResp = { data: 'stream data', status: 200 };
      vi.mocked(axios.post).mockResolvedValueOnce(fakeResp as unknown);

      const req: ZhipuChatRequest = {
        model: 'glm-4',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.5,
        top_p: 0.9,
        max_tokens: 500,
        tools: [{ type: 'function', function: { name: 'search' } }],
        tool_choice: 'auto',
        response_format: { type: 'json_object' },
        logprobs: true,
        user: 'stream-user',
        metadata: { source: 'test' }
      };
      await zhipuChatStream(req);

      expect(vi.mocked(axios.post)).toHaveBeenCalledWith(
        'https://api.zhipu.ai/v4/chat/completions',
        { ...req, stream: true },
        { 
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-api-key' },
          responseType: 'stream'
        }
      );
    });
  });
});
