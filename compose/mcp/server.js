#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const COMPOSE_DIR = process.env.DM_MCP_COMPOSE_DIR
  ? path.resolve(process.env.DM_MCP_COMPOSE_DIR)
  : path.resolve(__dirname, '..');

const SERVER_NAME = 'docker-magento';
const SERVER_VERSION = '1.0.0';
const DEFAULT_PROTOCOL = '2025-06-18';

const DEFAULT_TIMEOUT = 300000;
const LONG_TIMEOUT = 1800000;
const MAX_OUTPUT = 200000;

const ALLOW_DESTRUCTIVE = !!process.env.DM_MCP_ALLOW_DESTRUCTIVE;

const DESTRUCTIVE = ['removeall', 'removevolumes', 'remove', 'removenetwork'];
const INTERACTIVE = {
  bash: 'No interactive shell over MCP. Use the `cli` tool to run a single command.',
  mysql: 'Interactive SQL shell unavailable over MCP. Use the `db_query` tool.',
  log: 'Following logs (tail -f) is unsupported. Use the `logs` tool to read recent lines.',
  'create-user': 'This prompts interactively. Use the `magento` tool with `admin:user:create --admin-user=... --admin-password=... --admin-email=... --admin-firstname=... --admin-lastname=...`.',
  xdebug: 'Removed upstream: Xdebug runs in the dedicated phpfpm-xdebug container. Use the `cli` tool against that container if needed.',
};

function log(...args) {
  process.stderr.write('[docker-magento-mcp] ' + args.join(' ') + '\n');
}

function runBin(name, argv = [], { stdin = null, timeout = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    const exe = path.join(COMPOSE_DIR, 'bin', name);
    let child;
    try {
      child = spawn(exe, argv, { cwd: COMPOSE_DIR });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: `[spawn error] ${err.message}` });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + `\n[spawn error] ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) stderr += `\n[timed out after ${timeout}ms — process killed]`;
      resolve({ code: code === null ? -1 : code, stdout, stderr });
    });
    if (stdin != null) child.stdin.write(stdin);
    child.stdin.end();
  });
}

function runPipe(srcName, srcArgs, dstName, dstArgs, { timeout = LONG_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    const src = spawn(path.join(COMPOSE_DIR, 'bin', srcName), srcArgs, { cwd: COMPOSE_DIR });
    const dst = spawn(path.join(COMPOSE_DIR, 'bin', dstName), dstArgs, { cwd: COMPOSE_DIR });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      src.kill('SIGKILL');
      dst.kill('SIGKILL');
    }, timeout);
    src.stdout.pipe(dst.stdin);
    src.stderr.on('data', (d) => { stderr += `[${srcName}] ${d}`; });
    src.on('error', (err) => { stderr += `\n[${srcName} spawn error] ${err.message}`; });
    src.on('close', (code) => { if (code) stderr += `\n[${srcName} exited ${code}]`; });
    dst.stdout.on('data', (d) => { stdout += d; });
    dst.stderr.on('data', (d) => { stderr += d; });
    dst.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + `\n[${dstName} spawn error] ${err.message}` });
    });
    dst.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) stderr += `\n[timed out after ${timeout}ms — processes killed]`;
      resolve({ code: code === null ? -1 : code, stdout, stderr });
    });
  });
}

function normalizeArgs(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.trim() !== '') return value.trim().split(/\s+/);
  return [];
}

function toResult(display, { code, stdout, stderr }) {
  const ok = code === 0;
  let text = stdout || '';
  if (stderr && stderr.trim()) text += (text ? '\n' : '') + '[stderr]\n' + stderr.trim();
  if (!ok) text = `\`${display}\` exited with code ${code}.\n` + text;
  if (!text.trim()) text = ok ? `\`${display}\` completed with no output.` : `\`${display}\` failed (code ${code}) with no output.`;
  if (text.length > MAX_OUTPUT) {
    text = text.slice(0, MAX_OUTPUT) + `\n\n[output truncated at ${MAX_OUTPUT} characters]`;
  }
  return { content: [{ type: 'text', text }], isError: !ok };
}

const optionalArgs = { type: 'array', items: { type: 'string' }, description: 'Arguments passed through verbatim.' };
const requiredPath = { type: 'string', description: 'Path relative to the Magento root (inside the container), e.g. app/code/Vendor/Module.' };

const TOOLS = [
  {
    name: 'status',
    description: 'Show the status of all containers in this project (wraps `bin/docker-compose ps`). Use this first to check whether the stack is running.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      return ['docker-compose ps', await runBin('docker-compose', ['ps'])];
    },
  },
  {
    name: 'start',
    description: 'Start all project containers (wraps `bin/start`). Requires >=6GB RAM allocated to Docker.',
    inputSchema: {
      type: 'object',
      properties: { no_dev: { type: 'boolean', description: 'Start without the dev bind mounts (compose.dev.yaml).' } },
      additionalProperties: false,
    },
    async run(args) {
      const argv = args && args.no_dev ? ['--no-dev'] : [];
      return ['bin/start ' + argv.join(' '), await runBin('start', argv, { timeout: LONG_TIMEOUT })];
    },
  },
  {
    name: 'stop',
    description: 'Stop all project containers (wraps `bin/stop`).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      return ['bin/stop', await runBin('stop', [], { timeout: LONG_TIMEOUT })];
    },
  },
  {
    name: 'restart',
    description: 'Stop then start all project containers (wraps `bin/restart`).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      return ['bin/restart', await runBin('restart', [], { timeout: LONG_TIMEOUT })];
    },
  },
  {
    name: 'magento',
    description: 'Run the Magento CLI inside the phpfpm container (wraps `bin/magento`, i.e. `bin/cli bin/magento`). This is the primary tool for Magento commands: setup:upgrade, setup:di:compile, indexer:reindex, cache:flush, config:set, module:enable, admin:user:create, etc.',
    inputSchema: {
      type: 'object',
      properties: { args: { type: 'array', items: { type: 'string' }, description: 'Magento CLI arguments, e.g. ["setup:upgrade"] or ["config:set","web/secure/base_url","https://magento.test/"].' } },
      required: ['args'],
      additionalProperties: false,
    },
    async run(args) {
      const argv = normalizeArgs(args.args);
      return ['bin/magento ' + argv.join(' '), await runBin('magento', argv, { timeout: LONG_TIMEOUT })];
    },
  },
  {
    name: 'composer',
    description: 'Run Composer inside the phpfpm container (wraps `bin/composer`). Use for require/remove/install/update/dump-autoload.',
    inputSchema: {
      type: 'object',
      properties: { args: optionalArgs },
      required: ['args'],
      additionalProperties: false,
    },
    async run(args) {
      const argv = normalizeArgs(args.args);
      return ['bin/composer ' + argv.join(' '), await runBin('composer', argv, { timeout: LONG_TIMEOUT })];
    },
  },
  {
    name: 'magerun',
    description: 'Run n98-magerun2 inside the phpfpm container (wraps `bin/n98-magerun2`). Useful for db:dump, sys:info, cache:report, customer:create, dev:console, etc.',
    inputSchema: {
      type: 'object',
      properties: { args: optionalArgs },
      additionalProperties: false,
    },
    async run(args) {
      const argv = normalizeArgs(args && args.args);
      return ['bin/n98-magerun2 ' + argv.join(' '), await runBin('n98-magerun2', argv, { timeout: LONG_TIMEOUT })];
    },
  },
  {
    name: 'cache_clean',
    description: 'Clean Magento caches via the cache-clean CLI (wraps `bin/cache-clean`). Pass specific cache types, or none to clean all. Watch mode is intentionally unavailable over MCP.',
    inputSchema: {
      type: 'object',
      properties: { types: { type: 'array', items: { type: 'string' }, description: 'Cache types to clean, e.g. ["config","full_page"]. Omit to clean all.' } },
      additionalProperties: false,
    },
    async run(args) {
      const argv = normalizeArgs(args && args.types);
      return ['bin/cache-clean ' + argv.join(' '), await runBin('cache-clean', argv)];
    },
  },
  {
    name: 'db_query',
    description: 'Run a SQL statement against the project database (wraps `bin/mysql`; credentials come from env/db.env). The SQL is sent over stdin to the non-interactive client. Read or write queries are both supported.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'SQL to execute, e.g. "SELECT * FROM core_config_data LIMIT 5;".' },
        db: { type: 'string', description: 'Optional database name (defaults to the configured Magento DB).' },
      },
      required: ['sql'],
      additionalProperties: false,
    },
    async run(args) {
      const argv = args.db ? ['--db', String(args.db)] : [];
      const sql = String(args.sql).trim().endsWith(';') ? String(args.sql) : String(args.sql) + ';';
      return ['bin/mysql ' + argv.join(' '), await runBin('mysql', argv, { stdin: sql + '\n' })];
    },
  },
  {
    name: 'db_dump',
    description: 'Dump the project database to SQL (wraps `bin/mysqldump`, which uses n98-magerun2 db:dump). By default the dump is returned inline; pass to_file to write it to a path under the compose directory instead (recommended for large databases).',
    inputSchema: {
      type: 'object',
      properties: {
        args: optionalArgs,
        to_file: { type: 'string', description: 'Optional path (relative to the compose/ dir or absolute) to write the dump to.' },
      },
      additionalProperties: false,
    },
    async run(args) {
      const argv = normalizeArgs(args && args.args);
      const res = await runBin('mysqldump', argv, { timeout: LONG_TIMEOUT });
      if (res.code === 0 && args && args.to_file) {
        const target = path.isAbsolute(args.to_file) ? args.to_file : path.join(COMPOSE_DIR, args.to_file);
        try {
          fs.writeFileSync(target, res.stdout);
          return ['bin/mysqldump', { code: 0, stdout: `Wrote ${Buffer.byteLength(res.stdout)} bytes to ${target}`, stderr: res.stderr }];
        } catch (err) {
          return ['bin/mysqldump', { code: 1, stdout: res.stdout.slice(0, 2000), stderr: `Failed to write ${target}: ${err.message}` }];
        }
      }
      return ['bin/mysqldump ' + argv.join(' '), res];
    },
  },
  {
    name: 'db_import',
    description: 'Import a SQL dump into the project database. Cleans the dump first (wraps `bin/mysql-prepare`: strips DEFINER clauses and rewrites utf8mb4_0900_ai_ci) then pipes it into `bin/mysql`. Supports .sql and .sql.{gz,tgz,bz2,xz,zst}.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to the dump file, relative to the compose/ dir or absolute.' },
        db: { type: 'string', description: 'Optional target database name (defaults to the configured Magento DB).' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    async run(args) {
      const dstArgs = args.db ? ['--db', String(args.db)] : [];
      const res = await runPipe('mysql-prepare', [String(args.file)], 'mysql', dstArgs, { timeout: LONG_TIMEOUT });
      if (res.code === 0 && !res.stdout.trim()) res.stdout = `Imported ${args.file} successfully.`;
      return [`bin/mysql-prepare ${args.file} | bin/mysql ${dstArgs.join(' ')}`, res];
    },
  },
  {
    name: 'logs',
    description: 'Read recent lines from the Magento var/log files (non-following). Wraps `bin/clinotty tail`. Omit files to list the available log files.',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: 'Log file names under var/log, e.g. ["system.log","exception.log"]. Omit to list available files.' },
        lines: { type: 'number', description: 'Number of trailing lines per file (default 200).' },
      },
      additionalProperties: false,
    },
    async run(args) {
      const files = normalizeArgs(args && args.files);
      if (files.length === 0) {
        return ['ls var/log', await runBin('clinotty', ['ls', '-1', 'var/log'])];
      }
      const lines = Number.isInteger(args && args.lines) && args.lines > 0 ? args.lines : 200;
      const paths = files.map((f) => 'var/log/' + f.replace(/^var\/log\//, ''));
      return ['tail -n ' + lines + ' ' + paths.join(' '), await runBin('clinotty', ['tail', '-n', String(lines), ...paths])];
    },
  },
  {
    name: 'analyse',
    description: 'Run the full static-analysis suite (phpcs + phpmd + phpstan + php-compatibility) on a path (wraps `bin/analyse`).',
    inputSchema: { type: 'object', properties: { path: requiredPath }, required: ['path'], additionalProperties: false },
    async run(args) {
      return ['bin/analyse ' + args.path, await runBin('analyse', [String(args.path)], { timeout: LONG_TIMEOUT })];
    },
  },
  {
    name: 'phpcs',
    description: 'Run PHP_CodeSniffer with the Magento2 standard on a path (wraps `bin/phpcs`).',
    inputSchema: { type: 'object', properties: { path: requiredPath }, required: ['path'], additionalProperties: false },
    async run(args) {
      return ['bin/phpcs ' + args.path, await runBin('phpcs', [String(args.path)], { timeout: LONG_TIMEOUT })];
    },
  },
  {
    name: 'phpcbf',
    description: 'Auto-fix PHP_CodeSniffer violations with the Magento2 standard on a path (wraps `bin/phpcbf`).',
    inputSchema: { type: 'object', properties: { path: requiredPath }, required: ['path'], additionalProperties: false },
    async run(args) {
      return ['bin/phpcbf ' + args.path, await runBin('phpcbf', [String(args.path)], { timeout: LONG_TIMEOUT })];
    },
  },
  {
    name: 'test_unit',
    description: 'Run PHPUnit unit tests for a path (wraps `bin/test/unit`), e.g. app/code/Vendor/Module.',
    inputSchema: { type: 'object', properties: { path: requiredPath }, required: ['path'], additionalProperties: false },
    async run(args) {
      return ['bin/test/unit ' + args.path, await runBin('test/unit', [String(args.path)], { timeout: LONG_TIMEOUT })];
    },
  },
  {
    name: 'test_run',
    description: 'Run a PHPUnit test type under dev/tests (wraps `bin/dev-test-run`), e.g. type "integration".',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Test type directory under dev/tests, e.g. integration, api-functional.' },
        args: optionalArgs,
      },
      required: ['type'],
      additionalProperties: false,
    },
    async run(args) {
      const argv = [String(args.type), ...normalizeArgs(args.args)];
      return ['bin/dev-test-run ' + argv.join(' '), await runBin('dev-test-run', argv, { timeout: LONG_TIMEOUT })];
    },
  },
  {
    name: 'deploy',
    description: 'Run the standard Magento deployment process (wraps `bin/deploy`). Developer mode by default; production mode runs the full compile + static-content deploy.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['developer', 'production'], description: 'Deployment mode (default developer).' },
        args: { type: 'array', items: { type: 'string' }, description: 'Extra args passed to setup:static-content:deploy (production only).' },
      },
      additionalProperties: false,
    },
    async run(args) {
      const argv = [];
      if (args && args.mode) argv.push('--mode', String(args.mode));
      argv.push(...normalizeArgs(args && args.args));
      return ['bin/deploy ' + argv.join(' '), await runBin('deploy', argv, { timeout: LONG_TIMEOUT })];
    },
  },
  {
    name: 'cli',
    description: 'Escape hatch: run an arbitrary command in the phpfpm container as the app user, no TTY (wraps `bin/clinotty`). Prefer a named tool when one fits; use this only when none does.',
    inputSchema: {
      type: 'object',
      properties: { args: { type: 'array', items: { type: 'string' }, description: 'Command and arguments, e.g. ["php","-v"].' } },
      required: ['args'],
      additionalProperties: false,
    },
    async run(args) {
      const argv = normalizeArgs(args.args);
      if (argv.length === 0) return ['bin/clinotty', { code: 1, stdout: '', stderr: 'No command provided.' }];
      return ['bin/clinotty ' + argv.join(' '), await runBin('clinotty', argv, { timeout: LONG_TIMEOUT })];
    },
  },
  {
    name: 'cli_root',
    description: 'Escape hatch: run an arbitrary command in the phpfpm container as root, no TTY (wraps `bin/rootnotty`). Use sparingly, e.g. for permission fixes.',
    inputSchema: {
      type: 'object',
      properties: { args: { type: 'array', items: { type: 'string' }, description: 'Command and arguments to run as root.' } },
      required: ['args'],
      additionalProperties: false,
    },
    async run(args) {
      const argv = normalizeArgs(args.args);
      if (argv.length === 0) return ['bin/rootnotty', { code: 1, stdout: '', stderr: 'No command provided.' }];
      return ['bin/rootnotty ' + argv.join(' '), await runBin('rootnotty', argv, { timeout: LONG_TIMEOUT })];
    },
  },
  {
    name: 'bin',
    description: 'Escape hatch: run any project bin/ script not covered by a named tool (e.g. setup-domain, fixowns, fixperms, cron, copytocontainer, copyfromcontainer, setup-opensearch). Destructive scripts (removeall, removevolumes, etc.) and interactive scripts (bash, mysql, log, create-user) are refused — use the dedicated tools instead.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Name of the bin/ script, e.g. "setup-domain".' },
        args: optionalArgs,
      },
      required: ['command'],
      additionalProperties: false,
    },
    async run(args) {
      const command = String(args.command).replace(/^bin\//, '');
      if (!/^[a-zA-Z0-9._-]+$/.test(command)) {
        return ['bin', { code: 1, stdout: '', stderr: `Invalid script name "${command}".` }];
      }
      if (INTERACTIVE[command]) {
        return ['bin/' + command, { code: 1, stdout: '', stderr: `\`bin/${command}\` is blocked: ${INTERACTIVE[command]}` }];
      }
      if (!ALLOW_DESTRUCTIVE && DESTRUCTIVE.includes(command)) {
        return ['bin/' + command, { code: 1, stdout: '', stderr: `\`bin/${command}\` is destructive and blocked by default. Set DM_MCP_ALLOW_DESTRUCTIVE=1 in the server environment to enable it.` }];
      }
      if (!fs.existsSync(path.join(COMPOSE_DIR, 'bin', command))) {
        return ['bin/' + command, { code: 1, stdout: '', stderr: `No such script: bin/${command}` }];
      }
      const argv = normalizeArgs(args.args);
      return ['bin/' + command + ' ' + argv.join(' '), await runBin(command, argv, { timeout: LONG_TIMEOUT })];
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

const INSTRUCTIONS = [
  'This is a Dockerized Magento 2 environment (a customized fork of Mark Shust\'s docker-magento).',
  'You are likely working inside the Magento source root, which is mounted at /var/www/html in the phpfpm container. The environment scripts (bin/*), compose files, and env/ live in the environment root (the parent of the Magento source).',
  '',
  'ALWAYS drive this environment through these tools. NEVER run raw `docker exec`, `docker compose`, or a host `mysql` client — that bypasses the wrappers (compose-file layering, v1/v2 detection, the phpfpm Unix socket, DB credentials) and breaks the workflow.',
  '',
  'Services: app (Nginx), phpfpm (PHP 8.3, where Magento/Composer run), db (MariaDB), redis (Valkey), opensearch, rabbitmq, mailcatcher. DB credentials live in env/db.env at the environment root.',
  '',
  'Guidance:',
  '- Run Magento CLI with the `magento` tool; Composer with `composer`.',
  '- Query the DB with `db_query`, dump with `db_dump`, import with `db_import`. Do not shell out to mysql.',
  '- Read logs with `logs` (it cannot follow/tail -f). Check the stack with `status`.',
  '- Lint/analyse with `analyse`/`phpcs`/`phpcbf`; run tests with `test_unit`/`test_run`.',
  '- Paths passed to tools (e.g. app/code/Vendor/Module) are relative to the Magento source root.',
  '- Use `cli`/`cli_root`/`bin` only when no named tool fits. Destructive and interactive scripts are blocked.',
].join('\n');

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleMessage(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (err) {
    return; // ignore non-JSON / partial noise
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case 'initialize': {
        const protocolVersion = (params && params.protocolVersion) || DEFAULT_PROTOCOL;
        sendResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        });
        return;
      }
      case 'notifications/initialized':
      case 'initialized':
        return; // notification, no response
      case 'ping':
        if (!isNotification) sendResult(id, {});
        return;
      case 'tools/list':
        sendResult(id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
        return;
      case 'tools/call': {
        const name = params && params.name;
        const tool = TOOL_MAP.get(name);
        if (!tool) {
          sendError(id, -32602, `Unknown tool: ${name}`);
          return;
        }
        const args = (params && params.arguments) || {};
        try {
          const [display, exec] = await tool.run(args);
          sendResult(id, toResult(display, exec));
        } catch (err) {
          sendResult(id, { content: [{ type: 'text', text: `Tool ${name} failed: ${err.message}` }], isError: true });
        }
        return;
      }
      default:
        if (!isNotification) sendError(id, -32601, `Method not found: ${method}`);
        return;
    }
  } catch (err) {
    if (!isNotification) sendError(id, -32603, `Internal error: ${err.message}`);
  }
}

function main() {
  if (!fs.existsSync(path.join(COMPOSE_DIR, 'compose.yaml'))) {
    log(`warning: compose.yaml not found in ${COMPOSE_DIR}. Tools will fail until the compose dir is correct (set DM_MCP_COMPOSE_DIR).`);
  }
  log(`serving for compose dir: ${COMPOSE_DIR}`);

  let buffer = '';
  let pending = 0;
  let ending = false;
  const track = (promise) => {
    pending += 1;
    promise.finally(() => {
      pending -= 1;
      if (ending && pending === 0) process.exit(0);
    });
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) track(handleMessage(line));
    }
  });
  process.stdin.on('end', () => {
    ending = true;
    if (pending === 0) process.exit(0);
  });
}

main();
