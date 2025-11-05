import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logger } from './logger';
import * as fs from 'fs';
import * as path from 'path';

// Mock fs module
vi.mock('fs');
vi.mock('path');
vi.mock('pino-pretty', () => ({}));

describe('logger module', () => {
  const mockFs = vi.mocked(fs);
  const mockPath = vi.mocked(path);

  beforeEach(() => {
    vi.resetModules();
    mockFs.existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should create logger in development mode', async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    
    // Re-import logger with new environment
    const { logger: devLogger } = await import('./logger');
    
    expect(devLogger).toBeDefined();
    expect(devLogger.level).toBe('debug');
    
    process.env.NODE_ENV = prevEnv;
  });

  it('should create silent logger in test mode', async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    
    // Re-import logger with new environment
    const { logger: testLogger } = await import('./logger');
    
    expect(testLogger).toBeDefined();
    expect(testLogger.level).toBe('silent');
    
    process.env.NODE_ENV = prevEnv;
  });

  it('should create logger in production mode', async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    
    // Mock path.join to return a fake log path
    mockPath.join.mockReturnValue('/fake/logs/path');
    
    // Re-import logger with new environment
    const { logger: prodLogger } = await import('./logger');
    
    expect(prodLogger).toBeDefined();
    expect(prodLogger.level).toBe('debug');
    
    process.env.NODE_ENV = prevEnv;
  });

  it('should create logs directory when it does not exist', async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    mockFs.existsSync.mockReturnValue(false);
    
    // Re-import logger with new environment
    await import('./logger');
    
    expect(mockFs.mkdirSync).toHaveBeenCalledWith(
      path.join(process.cwd(), 'logs'),
      { recursive: true }
    );
    
    process.env.NODE_ENV = prevEnv;
  });

  it('should not create logs directory in test mode', async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    mockFs.existsSync.mockReturnValue(false);
    
    // Re-import logger with new environment
    await import('./logger');
    
    expect(mockFs.mkdirSync).not.toHaveBeenCalled();
    
    process.env.NODE_ENV = prevEnv;
  });

  it('should have correct log level for different environments', async () => {
    // Test development
    let prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    
    const { logger: devLogger } = await import('./logger');
    expect(devLogger.level).toBe('debug');
    
    process.env.NODE_ENV = prevEnv;

    // Test production
    prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    
    const { logger: prodLogger } = await import('./logger');
    expect(prodLogger.level).toBe('debug');
    
    process.env.NODE_ENV = prevEnv;

    // Test undefined (default)
    prevEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    
    const { logger: defaultLogger } = await import('./logger');
    expect(defaultLogger.level).toBe('debug');
    
    process.env.NODE_ENV = prevEnv;
  });

  it('should not throw errors when log directory creation fails in production', async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    mockFs.existsSync.mockReturnValue(false);
    mockFs.mkdirSync.mockImplementation(() => {
      throw new Error('Permission denied');
    });
    
    // Should not throw, just continue
    await expect(async () => {
      await import('./logger');
    }).not.toThrow();
    
    process.env.NODE_ENV = prevEnv;
  });
});

describe('logger instance', () => {
  it('should be defined and usable', () => {
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('should have expected methods', () => {
    const methods = ['info', 'error', 'warn', 'debug', 'fatal', 'trace'];
    methods.forEach(method => {
      expect(typeof logger[method as keyof typeof logger]).toBe('function');
    });
  });

  it('should handle info logging', () => {
    // This is a basic smoke test - in test mode logger is silent
    expect(() => logger.info('test message')).not.toThrow();
  });

  it('should handle error logging', () => {
    expect(() => logger.error('test error')).not.toThrow();
  });

  it('should handle warn logging', () => {
    expect(() => logger.warn('test warning')).not.toThrow();
  });

  it('should handle debug logging', () => {
    expect(() => logger.debug('test debug')).not.toThrow();
  });

  it('should handle child logger creation', () => {
    const child = logger.child({ component: 'test' });
    expect(child).toBeDefined();
    expect(typeof child.info).toBe('function');
  });
});