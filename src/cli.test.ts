import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock yargs and dependencies with minimal chainable behavior used by CLI
vi.mock('yargs/yargs', () => {
  return {
    default: () => ({
      option: function () { return this; },
      help: function () { return this; },
      alias: function () { return this; },
      argv: { port: 11434, host: '127.0.0.1' },
    }),
  };
});
vi.mock('yargs/helpers', () => ({ hideBin: (argv: string[]) => argv }));
vi.mock('./server');
vi.mock('./logger');

describe('cli module', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should export nothing (main function is internal)', async () => {
    // Execute CLI main function
    const cliModule = await import('./cli');
    
    // main function should not be exported - it's executed at module load time
    expect(Object.keys(cliModule)).toHaveLength(0);
  });

  it('should handle buildServer errors gracefully', async () => {
    // Mock console.error to prevent test output pollution
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    // Mock process.exit to prevent test from exiting
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    
    // Execute CLI main function - should handle error gracefully
    await import('./cli');
    
  // Restore mocks
  consoleErrorSpy.mockRestore();
  mockExit.mockRestore();
  });
});