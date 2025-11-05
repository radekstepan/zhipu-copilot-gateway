import pino from 'pino';
import fs from 'fs';
import path from 'path';

const isDevelopment = process.env.NODE_ENV !== 'production';
const isTest = process.env.NODE_ENV === 'test';

// Ensure logs directory exists
const logDir = path.join(process.cwd(), 'logs');
if (!isTest && !fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const pinoTargets: pino.TransportTargetOptions[] = [
  // Console logging (pretty-printed in development)
  {
    level: isDevelopment ? 'debug' : 'info',
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:HH:MM:ss',
      ignore: 'pid,hostname',
    },
  },
  // File logging for all levels for detailed debugging
  {
    level: 'debug',
    target: 'pino/file',
    options: { destination: path.join(logDir, 'debug.log'), mkdir: true },
  },
  // Separate, smaller error-only log file for quick diagnostics
  {
    level: 'error',
    target: 'pino/file',
    options: { destination: path.join(logDir, 'error.log'), mkdir: true },
  },
];

// During tests we want to avoid noisy logs or stack traces that make test
// output hard to read. Use a silent pino logger when running under the test
// environment. Otherwise, set up multi-target logging.
export const logger = isTest
  ? pino({ level: 'silent' })
  : pino({
      level: 'debug', // Set the minimum level to capture everything for transports
      transport: {
        targets: pinoTargets,
      },
    });
