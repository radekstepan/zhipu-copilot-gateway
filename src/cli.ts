#!/usr/bin/env node
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import { buildServer } from './server';
import { logger } from './logger';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 11434;

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('host', { type: 'string', description: `Host interface to bind (default: ${DEFAULT_HOST})`, default: DEFAULT_HOST })
    .option('port', { alias: 'p', type: 'number', description: `Port to bind (default: ${DEFAULT_PORT})`, default: DEFAULT_PORT })
    .help().alias('help', 'h').argv;

  try {
    const app = buildServer();
    await app.listen({ port: argv.port, host: argv.host });
  } catch (err) {
    logger.error(err, 'Application failed to start');
    process.exit(1);
  }
}

main();
