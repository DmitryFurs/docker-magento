# docker-magento MCP server

A small, **zero-dependency** [MCP](https://modelcontextprotocol.io) server that exposes this
project's `bin/*` workflow as first-class tools, so AI coding assistants (Claude Code, OpenAI
Codex, Cursor, Windsurf, …) drive the environment correctly instead of reaching for raw
`docker exec` / `docker compose` / host `mysql`.

- Server: `mcp/server.js` (Node, no `npm install` required)
- Launcher: `bin/mcp` (`exec node ../mcp/server.js`)
- Requires: **Node on the host** and a working Docker setup.

> Paths below are relative to the **project root** — the directory that holds `bin/`, `env/`,
> `compose.yaml`, and `src/`. (In the `docker-magento` template repo itself these same files live
> under `compose/`, e.g. `compose/bin/mcp`.)

## Layout & how it finds the environment

On an installed project the contents of `compose/` are the project root, and you open your AI tool
in `src/` (the Magento app), not at the project root:

```
<project>/            <- bin/* commands run here (terminal)
├── bin/mcp           <- launcher
├── mcp/server.js     <- this server (resolves the env root as its own ../)
└── src/              <- open Claude Code / Codex HERE
    └── .mcp.json     <- command: ../bin/mcp   (created by bin/setup-mcp)
```

The server spawns every `bin/*` script with the working directory set to the project root, so it
works no matter where the AI tool is opened.

## Setup

Run once per project (also run automatically by `bin/setup`):

```bash
bin/setup-mcp
```

This creates/updates `src/.mcp.json` with the `docker-magento` server (`command: ../bin/mcp`),
**preserving any other MCP servers** already configured there, and prints a ready-to-paste Codex
config snippet.

- **Claude Code / Cursor / Windsurf:** open the tool in `src/`; it picks up `src/.mcp.json`
  automatically. `src/.mcp.json` is gitignored by the Magento `.gitignore`, so it stays a local,
  per-developer file (whitelist it in `src/.gitignore` if you want to commit and share it).
- **OpenAI Codex:** Codex reads MCP servers from the global `~/.codex/config.toml`, so add the
  printed snippet (one entry per project, with the absolute path to `<project>/bin/mcp`):

  ```toml
  [mcp_servers.myproject-docker-magento]
  command = "/absolute/path/to/myproject/bin/mcp"
  args = []
  ```

## Tools

| Tool | What it does |
|------|--------------|
| `status` | Container status (`bin/docker-compose ps`). |
| `start` / `stop` / `restart` | Container lifecycle. `start` accepts `no_dev`. |
| `magento` | Magento CLI (`bin/magento`). Primary tool. |
| `composer` | Composer (`bin/composer`). |
| `magerun` | n98-magerun2 (`bin/n98-magerun2`). |
| `cache_clean` | Clean caches (`bin/cache-clean`, no watch mode). |
| `db_query` | Run SQL via stdin (`bin/mysql`). `sql`, optional `db`. |
| `db_dump` | Dump DB (`bin/mysqldump`); optional `to_file`. |
| `db_import` | Clean + import a dump (`bin/mysql-prepare \| bin/mysql`). `file`, optional `db`. |
| `logs` | Read recent log lines (`tail -n`, no `-f`). Lists files when called with none. |
| `analyse` / `phpcs` / `phpcbf` | Static analysis / lint / auto-fix. |
| `test_unit` / `test_run` | PHPUnit unit tests / typed test runner. |
| `deploy` | `bin/deploy` (developer or production mode). |
| `cli` / `cli_root` | Escape hatch: arbitrary command in phpfpm as app / root. |
| `bin` | Escape hatch: any other `bin/` script (guarded — see below). |

### Guardrails

The `bin` escape hatch refuses:

- **Destructive** scripts (`removeall`, `removevolumes`, `remove`, `removenetwork`) —
  blocked unless you set `DM_MCP_ALLOW_DESTRUCTIVE=1` in the server's environment.
- **Interactive** scripts (`bash`, `mysql`, `log`, `create-user`, `xdebug`) — these need a TTY or
  prompts, which MCP has no notion of. The error message points to the dedicated tool to use
  instead.

### Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `DM_MCP_COMPOSE_DIR` | `../` from server.js | Override the environment root. |
| `DM_MCP_ALLOW_DESTRUCTIVE` | unset | Allow destructive scripts through the `bin` tool. |

## Manual test

```bash
# Protocol smoke test (no Docker needed), from the project root:
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | bin/mcp

# With Docker running, call a tool:
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"status","arguments":{}}}' \
  | bin/mcp
```
