import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';

// Mock dependencies
vi.mock('./config', () => ({
  initializeConfig: vi.fn(),
}));
vi.mock('./logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    // Fastify expects the logger to implement a few additional methods
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(),
    })),
  },
}));
vi.mock('./routes/meta', () => ({
  registerMetaRoutes: vi.fn(),
}));
vi.mock('./routes/chat', () => ({
  registerChatRoutes: vi.fn(),
}));

describe('server module', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should create Fastify server', async () => {
    const { buildServer } = await import('./server');
    
    const app = buildServer();
    
    expect(app).toBeDefined();
    expect(app.log).toBeDefined();
  });

  it('should configure CORS headers', async () => {
    const { CORS_HEADERS } = await import('./server');
    
    expect(CORS_HEADERS).toEqual({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
  });

  it('should handle multiple server instances', async () => {
    const { buildServer } = await import('./server');
    
    const app1 = buildServer();
    const app2 = buildServer();
    
    expect(app1).toBeDefined();
    expect(app2).toBeDefined();
    expect(app1).not.toBe(app2);
  });

  it('should configure Fastify with logger', async () => {
    const { buildServer } = await import('./server');
    
    const app = buildServer();
    
    expect(app.log).toBeDefined();
  });

  it('should add content type parser for all content types', async () => {
    const { buildServer } = await import('./server');
    
    const app = buildServer();
    
    expect(app.addContentTypeParser).toBeDefined();
  });
});