import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { config, initializeConfig } from './config';

describe('config initialization', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    config.ZHIPUAI_API_KEY = '';
  });

  afterEach(() => {
    process.env = OLD_ENV;
    config.ZHIPUAI_API_KEY = '';
  });

  it('initializeConfig sets key when ZHIPUAI_API_KEY is present', () => {
    process.env.ZHIPUAI_API_KEY = 'direct-key';
    initializeConfig();
    expect(config.ZHIPUAI_API_KEY).toBe('direct-key');
  });

  it('initializeConfig resolves indirection when var name provided', () => {
    process.env.ZHIPU_API_KEY = 'MY_KEY';
    process.env.MY_KEY = 'realkey';
    initializeConfig();
    expect(config.ZHIPUAI_API_KEY).toBe('realkey');
  });

  it('initializeConfig throws when no API key is found', () => {
    delete process.env.ZHIPUAI_API_KEY;
    delete process.env.ZHIPU_API_KEY;
    expect(() => initializeConfig()).toThrow(/API key not found/);
  });
});
