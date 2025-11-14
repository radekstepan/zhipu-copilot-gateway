import detectPort from 'detect-port';
import killPort from 'kill-port';
import Fastify from 'fastify';
import { initializeConfig } from './config';
import { logger } from './logger';
import { registerMetaRoutes } from './routes/meta';
import { registerChatRoutes } from './routes/chat';

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const PORT = 11434;

export async function buildServer(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({ logger });

  // Ensure port 11434 is available before starting
  try {
    app.log.info(`🔍 Checking if port ${PORT} is available...`);
    
    // Check if port is in use
    const availablePort = await detectPort(PORT);
    
    if (availablePort !== PORT) {
      app.log.warn(`⚠️  Port ${PORT} is in use. Attempting to free it...`);
      
      // Kill the process using the port
      await killPort(PORT);
      app.log.info(`✅ Successfully freed port ${PORT}`);
      
      // Wait a moment for the port to be released
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Verify the port is now available
      const checkPort = await detectPort(PORT);
      if (checkPort !== PORT) {
        throw new Error(`Failed to free port ${PORT}. Please manually stop the process using this port.`);
      }
    }
    
    app.log.info(`✅ Port ${PORT} is available`);
  } catch (error: any) {
    app.log.error(`❌ Failed to prepare port ${PORT}:`, error.message);
    throw new Error(`Cannot start server: ${error.message}`);
  }

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