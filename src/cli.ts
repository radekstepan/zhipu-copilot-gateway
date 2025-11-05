#!/usr/bin/env node
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import { buildServer } from './server';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 11434;

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('host', { type: 'string', description: `Host interface to bind (default: ${DEFAULT_HOST})`, default: DEFAULT_HOST })
    .option('port', { alias: 'p', type: 'number', description: `Port to bind (default: ${DEFAULT_PORT})`, default: DEFAULT_PORT })
    .option('mode', { 
      alias: 'm', 
      type: 'string', 
      description: 'Mode: "proxy" (forward to Ollama) or "direct" (call Zhipu directly)', 
      choices: ['proxy', 'direct'],
      default: 'proxy' 
    })
    .help().alias('help', 'h').argv;

  const app = buildServer(argv.mode as 'proxy' | 'direct');
  try {
    await app.listen({ port: argv.port, host: argv.host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
