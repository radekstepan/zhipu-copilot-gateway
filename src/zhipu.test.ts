import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { normalizeModelName, zhipuChatOnce, ZhipuChatRequest } from './zhipu';

vi.mock('axios');

describe('zhipu utilities', () => {
  beforeEach(() => {
    vi.mocked(axios.post).mockReset();
  });

  it('normalizeModelName strips suffix after colon', () => {
    expect(normalizeModelName('glm-4.6:latest')).toBe('glm-4.6');
    expect(normalizeModelName('glm-4.6')).toBe('glm-4.6');
    expect(normalizeModelName('')).toBe('');
    // allow nullish values through (keeps behavior consistent)
    expect(normalizeModelName(null as any)).toBe(null);
  });

  it('zhipuChatOnce returns axios response data on success', async () => {
    const fakeResp = { data: { id: 'x', created: 1, model: 'glm-4', choices: [] } };
    vi.mocked(axios.post).mockResolvedValueOnce(fakeResp as any);

    const req: ZhipuChatRequest = { model: 'glm-4', messages: [{ role: 'user', content: 'hi' }] };
    const res = await zhipuChatOnce(req);

    expect(res).toEqual(fakeResp.data);
    expect(vi.mocked(axios.post)).toHaveBeenCalled();
  });

  it('zhipuChatOnce throws when axios.post rejects', async () => {
    const err = new Error('boom');
    vi.mocked(axios.post).mockRejectedValueOnce(err);

    const req: ZhipuChatRequest = { model: 'glm-4', messages: [{ role: 'user', content: 'hi' }] };
    await expect(zhipuChatOnce(req)).rejects.toThrow('boom');
  });
});
