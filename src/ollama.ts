import type { FastifyReply } from 'fastify';

export function createNdjsonWriter(reply: FastifyReply) {
  reply.header('Content-Type', 'application/x-ndjson; charset=utf-8');
  // Make sure to disable compression interference for streams if any proxy exists.
  return (obj: unknown) => {
    reply.raw.write(JSON.stringify(obj) + '\n');
  };
}

export function endNdjson(reply: FastifyReply) {
  reply.raw.end();
}

export function chunkText(s: string, size = 1024): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) {
    out.push(s.slice(i, i + size));
  }
  return out.length ? out : [''];
}
