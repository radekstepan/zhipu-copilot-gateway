import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'fs';
import path from 'path';
import { CORS_HEADERS } from '../server';

// Load GLM models list from JSON file
const MODELS_PATH = path.join(__dirname, '..', 'models.json');
const GLM_MODELS = JSON.parse(fs.readFileSync(MODELS_PATH, 'utf8'));

export function registerMetaRoutes(app: FastifyInstance<any, any, any, any>) {
  // Global OPTIONS preflight handler for CORS
  app.options('/*', async (request: FastifyRequest, reply: FastifyReply) => {
    reply.headers(CORS_HEADERS).code(204).send();
  });

  // GET /api/version - Returns a hardcoded, compatible version string.
  app.get('/api/version', async (request: FastifyRequest, reply: FastifyReply) => {
    reply
      .headers({ ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' })
      .send({ version: '0.6.5' });
  });

  // GET /api/tags - Lists all available models from models.json.
  app.get('/api/tags', async (request: FastifyRequest, reply: FastifyReply) => {
    reply
      .headers({ ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' })
      .send({ models: GLM_MODELS });
  });

  // POST /api/show - Provides detailed information about a specific model.
  app.post('/api/show', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { model: string };
    const modelName = body?.model;

    const model = GLM_MODELS.find((m: any) => m.model === modelName);

    if (!model) {
      return reply
        .code(404)
        .headers(CORS_HEADERS)
        .send({ error: `model '${modelName}' not found` });
    }

    // This response structure mimics a real Ollama server response.
    const response = {
      license: 'Apache 2.0',
      modelfile: `# For more details, see https://www.zhipuai.com/\nFROM ${model.model}`,
      parameters: 'stop                           [INST]\nstop                           [/INST]\nstop                           <|user|>\nstop                           <|assistant|>',
      template: `[INST] {{ .System }} {{ .Prompt }} [/INST]`,
      details: {
        ...model.details,
        family: 'glm',
        families: ['glm'],
      },
      model_info: {
        'general.architecture': 'glm',
        'general.basename': model.model.split(':')[0],
        'glm.context_length': 32768, // A common context length for GLM-4 models
      },
      capabilities: ['tools', 'vision'], // Advertise tool and vision capabilities
    };

    reply
      .headers({ ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' })
      .send(response);
  });
}
