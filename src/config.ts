import dotenv from 'dotenv';

dotenv.config();

function resolveEnvVar(varName: string): string | undefined {
  const directValue = process.env[varName];
  if (!directValue) return undefined;
  if (directValue.match(/^[A-Z0-9_]+$/) && process.env[directValue]) {
    return process.env[directValue];
  }
  return directValue;
}

export const config = {
  ZHIPUAI_API_KEY: '',
  // Keep the base you’ve been using; change if your Zhipu account uses a different one.
  ZHIPUAI_API_BASE_URL: process.env.ZHIPUAI_API_BASE_URL || 'https://api.z.ai/api/coding/paas/v4',
  // Default GLM model to use when the client requests an unknown model name
  DEFAULT_ZHIPU_MODEL: (process.env.DEFAULT_ZHIPU_MODEL || 'glm-4').trim(),
};

export const initializeConfig = () => {
  const apiKeyNames = ['ZHIPU_API_KEY', 'ZHIPUAI_API_KEY'];
  let apiKey: string | undefined;
  for (const name of apiKeyNames) {
    apiKey = resolveEnvVar(name);
    if (apiKey) break;
  }
  if (!apiKey) {
    throw new Error(`API key not found. Please set ${apiKeyNames.join(' or ')} in your environment.`);
  }
  config.ZHIPUAI_API_KEY = apiKey;
};
