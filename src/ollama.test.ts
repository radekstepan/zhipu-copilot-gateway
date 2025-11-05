import { describe, it, expect, vi } from 'vitest';
import { chunkText, createNdjsonWriter, endNdjson } from './ollama';

describe('ollama utilities', () => {
  it('chunkText splits correctly', () => {
    expect(chunkText('', 5)).toEqual(['']);
    expect(chunkText('abcdef', 2)).toEqual(['ab', 'cd', 'ef']);
    expect(chunkText('a', 10)).toEqual(['a']);
  });

  it('createNdjsonWriter writes ndjson and endNdjson ends the stream', () => {
    const writes: string[] = [];
    const raw = { write: (s: string) => writes.push(s), end: vi.fn() };
    const reply: any = { header: vi.fn(), raw };

    const writer = createNdjsonWriter(reply);
    writer({ hello: 'world' });

    expect(reply.header).toHaveBeenCalledWith('Content-Type', 'application/x-ndjson; charset=utf-8');
    expect(writes[0]).toBe(JSON.stringify({ hello: 'world' }) + '\n');

    endNdjson(reply);
    expect(raw.end).toHaveBeenCalled();
  });
});
