import axios, { AxiosResponse } from 'axios';
import { config } from './config';
import { logger } from './logger';

// ---- Minimal Zhipu request/response shapes (local to this file) ----
export type ChatMessageContentPart = {
  type: string;
  text?: string;
  image_url?: { url: string; [key: string]: any };
  [key: string]: any;
};

export type ChatMessageContent = string | ChatMessageContentPart[];

export interface ChatCompletionToolCallFunction {
  name: string;
  arguments: string;
  [key: string]: any;
}

export interface ChatCompletionToolCall {
  id?: string;
  type: 'function';
  function: ChatCompletionToolCallFunction;
  [key: string]: any;
}

export interface ZhipuChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | string;
  content?: ChatMessageContent;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatCompletionToolCall[];
  refusal?: string;
  [key: string]: any;
}

export interface ZhipuChatRequest {
  model: string;
  messages: ZhipuChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  tools?: Array<Record<string, any>>;
  tool_choice?: Record<string, any> | string;
  response_format?: Record<string, any>;
  logprobs?: boolean;
  user?: string;
  metadata?: Record<string, any>;
  [key: string]: any;
}

export interface ZhipuChatNonStreamResp {
  id: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message?: {
      role: 'assistant';
      content?: string | ChatMessageContentPart[] | null;
      tool_calls?: ChatCompletionToolCall[];
      refusal?: string;
      [key: string]: any;
    };
    delta?: {
      role?: 'assistant';
      content?: string | ChatMessageContentPart[];
      tool_calls?: ChatCompletionToolCall[];
      [key: string]: any;
    };
    finish_reason?: string | null;
    [key: string]: any;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  [key: string]: any;
}

const CHAT_PATH = '/chat/completions';

const headers = () => ({
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${config.ZHIPUAI_API_KEY}`,
});

export async function zhipuChatOnce(req: ZhipuChatRequest): Promise<ZhipuChatNonStreamResp> {
  const url = `${config.ZHIPUAI_API_BASE_URL}${CHAT_PATH}`;
  try {
    logger.debug({ url, model: req.model, body: req }, 'Calling Zhipu (non-stream)');
    const res = await axios.post(url, { ...req, stream: false }, { headers: headers() });
    // Log a truncated preview of the response body to aid debugging
    try {
      const preview = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      logger.debug({ status: res.status, preview: preview.slice(0, 2000) }, 'Zhipu response preview');
    } catch (err) {
      logger.debug({ status: res.status }, 'Zhipu response (unserializable preview)');
    }
    return res.data as ZhipuChatNonStreamResp;
  } catch (error: any) {
    // Provide more context in logs for debugging upstream failures
    logger.error({ err: error?.toString?.() ?? String(error), response: error?.response?.data, model: req.model }, 'Zhipu API call failed');
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
  // Return the portion before any ':' (e.g. "glm-4.6:latest" -> "glm-4.6")
  return model.includes(':') ? model.split(':')[0] : model;
}
