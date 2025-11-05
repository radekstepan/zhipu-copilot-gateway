import pino from 'pino';

const isDevelopment = process.env.NODE_ENV !== 'production';
const isTest = process.env.NODE_ENV === 'test';

// During tests we want to avoid noisy logs or stack traces that make test
// output hard to read. Use a silent pino logger when running under the test
// environment. In development, keep the pretty transport.
export const logger = isTest
  ? pino({ level: 'silent' })
  : pino(
      isDevelopment
        ? {
            level: 'info',
            transport: {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'SYS:HH:MM:ss',
                ignore: 'pid,hostname',
              },
            },
          }
        : { level: 'info' }
    );
