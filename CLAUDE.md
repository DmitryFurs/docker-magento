# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## AI tooling — use the bin/* workflow

An MCP server ships with this repo at `compose/mcp/server.js` (launcher `compose/bin/mcp`) that
exposes the `bin/*` workflow as tools. **Always** drive this environment through those tools or
the `bin/*` scripts; **never** run raw `docker exec`, `docker compose`, or a host `mysql` client —
that bypasses the wrappers and breaks the environment. On installed projects the contents of
`compose/` become the project root and `bin/setup-mcp` seeds `src/.mcp.json` (where Claude/Codex
are opened) pointing at `../bin/mcp`. See [`compose/mcp/README.md`](compose/mcp/README.md) for the
tool list and per-client setup.

## Project Overview

Docker development environment for Magento 2, based on Mark Shust's docker-magento (v52.1.0). All commands run from the `compose/` directory. The Magento source lives inside Docker volumes and `compose/src/`.

## Architecture

**Services** (defined in `compose/compose.yaml`):
- **app** (Nginx 1.24) — web server, ports 80/443
- **phpfpm** (PHP 8.3) — application server, communicates with Nginx via Unix socket
- **db** (MariaDB 11.4) — database, port 3306. MySQL 8.4 available as commented alternative
- **redis** (Valkey 8.1) — cache/sessions, port 6379
- **opensearch** (2.12) — search engine, port 9200. Elasticsearch available as commented alternative
- **rabbitmq** (4.1) — message queue, ports 5672/15672
- **mailcatcher** — email testing, port 1080

**Compose file layering** (`compose/bin/docker-compose`):
1. `compose.yaml` — base services (always loaded)
2. `compose.healthcheck.yaml` — health checks (always loaded)
3. `compose.dev.yaml` — dev bind mounts for hot-reload (loaded unless `--no-dev` passed)

**Environment config**: `compose/env/*.env` files (db.env, magento.env, phpfpm.env, opensearch.env, rabbitmq.env, etc.)

## Key Commands

All bin scripts are in `compose/bin/`. Run from the `compose/` directory. A Makefile wraps every script (`make <command>`).

### Container lifecycle
```bash
bin/start                    # start all services (checks 6GB RAM minimum)
bin/start --no-dev           # start without dev bind mounts
bin/stop                     # stop services
bin/restart                  # restart services
bin/status                   # container status
```

### Running commands inside containers
```bash
bin/cli <command>            # exec in phpfpm (with TTY)
bin/clinotty <command>       # exec in phpfpm (no TTY)
bin/root <command>           # exec as root
bin/bash                     # interactive shell in phpfpm
```

### Magento
```bash
bin/magento <args>           # wraps `bin/cli bin/magento`
bin/composer <args>          # wraps `bin/cli composer`
bin/n98-magerun2 <args>      # n98-magerun2 CLI
bin/cache-clean              # clear caches
bin/log                      # tail Magento logs
bin/setup                    # full Magento installation from scratch
bin/setup-domain <domain>    # configure base URLs + SSL
```

### Testing
```bash
bin/test/unit <path>                 # unit tests: bin/test/unit app/code/Vendor/Module
bin/test/unit-coverage <path>        # unit tests with coverage
bin/dev-test-run integration         # integration tests
bin/dev-test-run <type>              # any test type under dev/tests/
```

### Code quality
```bash
bin/analyse <path>           # runs phpcs + phpmd + phpstan + php-compatibility
bin/phpcs <path>             # PHP_CodeSniffer with Magento2 standard
bin/phpcbf <path>            # auto-fix CodeSniffer errors
```

### Debugging
```bash
bin/xdebug debug             # enable Xdebug debug mode
bin/xdebug off               # disable Xdebug
bin/xdebug coverage          # enable coverage mode
bin/xdebug                   # show current mode + available modes
bin/debug-cli <command>      # run Magento CLI with Xdebug attached
```

### Database
```bash
bin/mysql                    # MySQL CLI (credentials from env/db.env)
bin/mysqldump                # database backup
```

### File sync
```bash
bin/copyfromcontainer <path> # copy from container to host
bin/copytocontainer <path>   # copy from host to container
bin/fixowns                  # fix ownership
bin/fixperms                 # fix permissions
```

## Script Conventions

- Shebang: `#!/usr/bin/env bash`
- Error handling: `set -o errexit` or `set -euo pipefail`
- All container commands go through `bin/docker-compose` (auto-detects compose v1/v2)
- CLI execution pattern: `bin/cli` → `bin/docker-compose exec phpfpm`
- Environment sourcing: `source env/db.env` or `source ../env/magento.env`

## Custom Docker Images

Built from `images/` directory, published as `markoshust/magento-*`:
- `images/php/` — PHP-FPM 8.1-8.4 (Debian bookworm, includes Composer 2.8.6, Node 22.x, Xdebug, Redis ext)
- `images/nginx/` — Nginx 1.18-1.24 (Alpine, mkcert for SSL)
- `images/opensearch/` — OpenSearch 1.2, 2.5, 2.12
- `images/elasticsearch/` — Elasticsearch 7.16-8.13
- `images/rabbitmq/` — RabbitMQ 3.9-4.1

PHP and Nginx containers run as user `app` (UID 1000).