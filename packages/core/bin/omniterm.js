#!/usr/bin/env node
// CLI wrapper for the standalone `omniterm` experience.
//
// `npm install -g @omniterm/host && omniterm` boots the host with the bundled
// terminal plugin. CLI flags map onto startServer() options.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
  console.log(pkg.version);
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: omniterm [options]

Options:
  --port <port>       Bind port (default: 17717, env: OMNITERM_PORT)
  --host <host>       Bind address (default: 0.0.0.0, env: OMNITERM_HOST)
  --version, -v       Print version and exit
  --help, -h          Show this help
`);
  process.exit(0);
}

function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

const port = flagValue('--port') ? parseInt(flagValue('--port'), 10) : undefined;
const host = flagValue('--host');

const { startServer } = await import('../dist/index.js');
await startServer({ port, host });
