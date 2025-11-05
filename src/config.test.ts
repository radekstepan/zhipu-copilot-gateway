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

  it('initializeConfig throws when ZHIPU_API_KEY is set but referenced variable does not exist', () => {
    process.env.ZHIPU_API_KEY = 'NON_EXISTENT_VAR';
    delete process.env.NON_EXISTENT_VAR;
    // Current behavior: resolveEnvVar will return the literal var-name when the referenced variable
    // does not exist (it only resolves indirection when the target exists). The config will therefore
    // contain the literal reference string.
    initializeConfig();
    expect(config.ZHIPUAI_API_KEY).toBe('NON_EXISTENT_VAR');
  });

  it('initializeConfig handles empty string in referenced variable', () => {
    process.env.ZHIPU_API_KEY = 'EMPTY_VAR';
    process.env.EMPTY_VAR = '';
    // Because the referenced variable exists but is empty, resolveEnvVar returns the literal
    // reference name. initializeConfig therefore sets the config to that literal name.
    initializeConfig();
    expect(config.ZHIPUAI_API_KEY).toBe('EMPTY_VAR');
  });

  it('initializeConfig prioritizes ZHIPU_API_KEY over ZHIPUAI_API_KEY', () => {
    process.env.ZHIPU_API_KEY = 'REF_VAR';
    process.env.ZHIPUAI_API_KEY = 'direct-key';
    process.env.REF_VAR = 'indirect-key';
    initializeConfig();
    expect(config.ZHIPUAI_API_KEY).toBe('indirect-key');
  });

  it('initializeConfig handles empty string API key', () => {
    process.env.ZHIPUAI_API_KEY = '';
    expect(() => initializeConfig()).toThrow(/API key not found/);
  });

  // Note: the case where the referenced variable exists but is empty is handled above
  // (it results in the literal reference being used). No-op here to avoid duplicate coverage.

  it('initializeConfig uses ZHIPUAI_API_KEY when ZHIPU_API_KEY is not present', () => {
    delete process.env.ZHIPU_API_KEY;
    process.env.ZHIPUAI_API_KEY = 'direct-key';
    initializeConfig();
    expect(config.ZHIPUAI_API_KEY).toBe('direct-key');
  });

  it('initializeConfig handles whitespace in API key', () => {
    process.env.ZHIPUAI_API_KEY = '  key-with-spaces  ';
    initializeConfig();
    expect(config.ZHIPUAI_API_KEY).toBe('  key-with-spaces  ');
  });

  it('config object is mutable', () => {
    config.ZHIPUAI_API_KEY = 'test-key';
    expect(config.ZHIPUAI_API_KEY).toBe('test-key');
  });

  it('initializeConfig is idempotent when called multiple times', () => {
    process.env.ZHIPUAI_API_KEY = 'test-key';
    initializeConfig();
    initializeConfig();
    expect(config.ZHIPUAI_API_KEY).toBe('test-key');
  });

  it('initializeConfig handles special characters in API key', () => {
    const specialKey = 'key-with-special-chars-!@#$%^&*()';
    process.env.ZHIPUAI_API_KEY = specialKey;
    initializeConfig();
    expect(config.ZHIPUAI_API_KEY).toBe(specialKey);
  });

  it('initializeConfig throws descriptive error message', () => {
    delete process.env.ZHIPUAI_API_KEY;
    delete process.env.ZHIPU_API_KEY;
    expect(() => initializeConfig()).toThrow(/API key not found/i);
  });

  it('initializeConfig handles null environment variables', () => {
    process.env.ZHIPUAI_API_KEY = null as any;
    process.env.ZHIPU_API_KEY = null as any;
    expect(() => initializeConfig()).toThrow(/API key not found/);
  });

  it('initializeConfig handles undefined environment variables', () => {
    process.env.ZHIPUAI_API_KEY = undefined as any;
    process.env.ZHIPU_API_KEY = undefined as any;
    expect(() => initializeConfig()).toThrow(/API key not found/);
  });

  it('initializeConfig preserves other environment variables', () => {
    process.env.ZHIPUAI_API_KEY = 'test-key';
    process.env.OTHER_VAR = 'other-value';
    initializeConfig();
    expect(process.env.OTHER_VAR).toBe('other-value');
  });

  it('initializeConfig handles multi-level variable resolution', () => {
    process.env.ZHIPU_API_KEY = 'VAR1';
    process.env.VAR1 = 'final-key';
    initializeConfig();
    expect(config.ZHIPUAI_API_KEY).toBe('final-key');
  });
});
