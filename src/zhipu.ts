import axios, { AxiosResponse } from 'axios';
import { config } from './config';

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
  const res = await axios.post(url, { ...req, stream: false }, { headers: headers() });
  return res.data as ZhipuChatNonStreamResp;
}

export async function zhipuChatStream(
  req: ZhipuChatRequest
): Promise<AxiosResponse<any>> {
  const url = `${config.ZHIPUAI_API_BASE_URL}${CHAT_PATH}`;
  return axios.post(url, { ...req, stream: true }, { headers: headers(), responseType: 'stream' });
}

/** Normalize "glm-4.6:latest" -> "glm-4.6" for Zhipu model names */
export function normalizeModelName(model: string): string {
  if (!model) return model;
  return model.includes(':') ? model.split(':')[0] : model;
}
