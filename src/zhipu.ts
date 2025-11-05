import axios, { AxiosResponse } from 'axios';
import { config } from './config';
import { logger } from './logger';

// ---- Minimal Zhipu request/response shapes (local to this file) ----
export interface ZhipuChatRequest {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
}
export interface ZhipuChatNonStreamResp {
  id: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message?: { role: 'assistant'; content: string };
    delta?: { role?: 'assistant'; content?: string };
    finish_reason?: string | null;
  }>;
}

const CHAT_PATH = '/chat/completions';

const headers = () => ({
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${config.ZHIPUAI_API_KEY}`,
});

export async function zhipuChatOnce(req: ZhipuChatRequest): Promise<ZhipuChatNonStreamResp> {
  const url = `${config.ZHIPUAI_API_BASE_URL}${CHAT_PATH}`;
  try {
    logger.debug({ url, model: req.model }, 'Calling Zhipu (non-stream)');
    const res = await axios.post(url, { ...req, stream: false }, { headers: headers() });
    // Log a truncated preview of the response body to aid debugging
    try {
      const preview = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      logger.debug({ status: res.status, preview: preview.slice(0, 1000) }, 'Zhipu response preview');
    } catch (err) {
      logger.debug({ status: res.status }, 'Zhipu response (unserializable preview)');
    }
    return res.data as ZhipuChatNonStreamResp;
  } catch (error: any) {
    // Provide more context in logs for debugging upstream failures
    logger.error({ err: error?.toString?.() ?? String(error), model: req.model }, 'Zhipu API call failed');
    throw error;
  }
}

export async function zhipuChatStream(
  req: ZhipuChatRequest
): Promise<AxiosResponse<any>> {
  const url = `${config.ZHIPUAI_API_BASE_URL}${CHAT_PATH}`;
  logger.debug({ url, model: req.model }, 'Calling Zhipu (stream)');
  const res = await axios.post(url, { ...req, stream: true }, { headers: headers(), responseType: 'stream' });
  logger.debug({ status: res.status }, 'Zhipu stream response status');
  return res;
}

/** Normalize "glm-4.6:latest" -> "glm-4.6" for Zhipu model names */
export function normalizeModelName(model: string): string {
  if (!model) return model;
  return model.includes(':') ? model.split(':')[0] : model;
}
