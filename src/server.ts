import Fastify, { FastifyInstance } from 'fastify';
import { initializeConfig } from './config';
import { logger } from './logger';
import { registerMetaRoutes } from './routes/meta';
import { registerChatRoutes } from './routes/chat';

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export function buildServer(): ReturnType<typeof Fastify> {
  const app = Fastify({ logger });

  // Initialize Zhipu API configuration on startup
  try {
    initializeConfig();
  } catch (error) {
    app.log.error(error, 'Failed to initialize configuration');
    throw error; // Re-throw the error instead of exiting the process
  }

  // Keep raw body for downstream processing
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (req, body, done) => {
    done(null, body);
  });

  // Health check endpoint
  app.get('/', async () => ({
    status: 'ok',
    message: 'Zhipu Ollama Gateway is running',
  }));

  // Register all application routes
  registerMetaRoutes(app);
  registerChatRoutes(app);

  app.log.info('🚀 Zhipu Ollama Gateway ready');
  app.log.info('🎯 Calling Zhipu GLM directly (no local Ollama required)');

  return app;
}