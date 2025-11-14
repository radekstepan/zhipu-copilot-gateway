import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../server';
import models from '../models.json';

describe('Meta Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // Set a dummy API key to prevent config initialization from failing
    process.env.ZHIPUAI_API_KEY = 'dummy-test-key';
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/version should return a valid version', async () => {
    const response = await supertest(app.server).get('/api/version');
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('version');
    expect(response.body.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('GET /api/tags should return the list of models', async () => {
    const response = await supertest(app.server).get('/api/tags');
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('models');
    expect(response.body.models).toEqual(models);
  });

  it('POST /api/show should return details for a valid model', async () => {
    const modelToShow = models[0].model;
    const response = await supertest(app.server)
      .post('/api/show')
      .send({ model: modelToShow });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('model_info');
    expect(response.body.model_info['general.basename']).toBe(modelToShow.split(':')[0]);
  });

  it('POST /api/show should return 404 for an invalid model', async () => {
    const response = await supertest(app.server)
      .post('/api/show')
      .send({ model: 'non-existent-model:latest' });

    expect(response.status).toBe(404);
    expect(response.body).toHaveProperty('error');
  });
});
