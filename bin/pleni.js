#!/usr/bin/env node
// Command line: pleni [--port N] [--demo] [--open] [--config FILE]
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';

const PACKAGE_FILE = new URL('../package.json', import.meta.url);
const OPTIONS = {
  port: { type: 'string' },
  demo: { type: 'boolean' },
  open: { type: 'boolean' },
  config: { type: 'string' },
  version: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
};

main(process.argv.slice(2), process.env).then(
  (code) => {
    if (code !== undefined) process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`Pleni stopped because of a problem: ${err?.message ?? 'unknown problem'}\n`);
    process.exitCode = 1;
  },
);

async function main(argv, env) {
  if (!nodeIsNewEnough(process.versions.node)) {
    process.stderr.write(`Pleni needs Node.js 22.12 or newer. This computer has ${process.version}.\n`);
    return 1;
  }
  let options;
  try {
    options = readOptions(argv, env);
  } catch (err) {
    process.stderr.write(`${err.message}\nRun "${commandName()} --help" to see what you can use.\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(await helpText(options, env));
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }
  // Loaded only now, so the version check above can still speak on an old Node.js.
  const { start } = await import('../src/server.js');
  let app;
  try {
    app = await start({ port: options.port, configFile: options.config, demo: options.demo, open: options.open });
  } catch (err) {
    process.stderr.write(`${startProblem(err, options.port)}\n`);
    return 1;
  }
  if (options.demo) process.stdout.write('Showing made-up demo data.\n');
  process.stdout.write(`Pleni is running at ${app.url}\n` +
    'Open that whole address. The part after "?t=" is a key that keeps other people on this computer out.\n' +
    'The key changes each time Pleni starts.\nPress Ctrl+C to stop.\n');
  stopOnSignal(app);
  return undefined;
}

function readOptions(argv, env) {
  let parsed;
  try {
    parsed = util.parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false });
  } catch (err) {
    // Node's messages add advice about "--"; the first sentence is the useful part.
    throw new Error(`${String(err.message).split('. ')[0].replace(/\.$/, '')}.`);
  }
  const values = parsed.values;
  const options = {
    port: undefined,
    demo: values.demo === true,
    open: values.open === true,
    config: values.config?.trim() ? path.resolve(values.config.trim()) : undefined,
    version: values.version === true,
    help: values.help === true,
  };
  // Help and the version need nothing else, so a bad PLENI_PORT or --config never hides them.
  if (options.help || options.version) return options;
  if (values.port !== undefined) options.port = parsePort(values.port, '--port');
  else if (typeof env.PLENI_PORT === 'string' && env.PLENI_PORT.trim()) options.port = parsePort(env.PLENI_PORT.trim(), 'PLENI_PORT');
  if (values.config !== undefined && !options.config) throw new Error('--config needs the name of a settings file.');
  return options;
}

// How this copy of Pleni was started, so the commands we suggest work when copied:
// "pleni" once it is installed as a command, else "node bin/pleni.js" (or the full path to it).
function commandName(script = process.argv[1] ?? '') {
  if (path.basename(script) !== 'pleni.js' || /[\\/]node_modules[\\/]/.test(script)) return 'pleni';
  const relative = path.relative(process.cwd(), script);
  const inside = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  const shown = inside ? relative.split(path.sep).join('/') : script;
  return `node ${/\s/.test(shown) ? `"${shown}"` : shown}`;
}

// 0 is allowed on purpose: it asks for any free port, which tests use.
function parsePort(text, from) {
  if (!/^\d{1,5}$/.test(text) || Number(text) > 65535) {
    throw new Error(`${from} must be a port number from 1 to 65535.`);
  }
  return Number(text);
}

function startProblem(err, port) {
  const which = err?.port ?? port;
  if (err?.code === 'EADDRINUSE') {
    return `Port ${which} is already in use. Pleni may already be running there.\n` +
      `Open that page, or pick another port, for example: ${commandName()} --port ${otherPort(which)}`;
  }
  if (err?.code === 'EACCES') return `Pleni is not allowed to use port ${which}. Try a port from 1024 to 65535.`;
  return `Pleni could not start: ${err?.message ?? 'unknown problem'}`;
}

// The next port up, or the one below when there is no port above.
function otherPort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1) return 8791;
  return n < 65535 ? n + 1 : n - 1;
}

function stopOnSignal(app) {
  let stopping = false;
  const stop = () => {
    // A second Ctrl+C means "stop right now".
    if (stopping) process.exit(130);
    stopping = true;
    process.stdout.write('Stopping Pleni...\n');
    setTimeout(() => process.exit(0), 3000).unref();
    app.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function helpText(options, env) {
  const { settingsFile } = await import('../src/config.js');
  const file = options.config ?? settingsFile(env);
  return `Pleni shows your Claude Code and Codex sessions live in your web browser.
It only reads them. Nothing leaves your computer.

Usage: ${commandName()} [options]

Options:
  --port N       Use port N. The default is 8790, or the port in your settings.
  --demo         Show made-up demo data instead of your own sessions.
  --open         Open Pleni in your web browser.
  --config FILE  Read and save settings in FILE.
  --version      Show the version number.
  --help         Show this help.

Environment:
  PLENI_PORT     The port to use when --port is not given.
  PLENI_HOME     The folder that holds the settings file.

Settings file: ${file}
`;
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(PACKAGE_FILE, 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function nodeIsNewEnough(version) {
  const [major, minor] = String(version).split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 12);
}
