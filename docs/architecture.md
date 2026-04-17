# Architecture

## Monorepo layout

```
yt2pt/
├── bin/                         # bundled yt-dlp (linux, macos)
├── deploy/                      # install.sh, uninstall.sh, yt2ptd.service
├── docs/                        # this documentation set
├── packages/
│   ├── shared/                  # @yt2pt/shared (config, paths, logger)
│   ├── daemon/                  # @yt2pt/daemon (yt2ptd)
│   │   ├── src/db/              #   SQLite schema + queries
│   │   ├── src/peertube/        #   PeerTube HTTP client
│   │   ├── src/queue/           #   in-process job queue
│   │   ├── src/routes/          #   Fastify route modules
│   │   ├── src/sync/            #   channel sync engine
│   │   ├── src/workers/         #   download / convert / upload processors
│   │   ├── src/server.ts        #   buildServer(ctx)
│   │   └── src/yt2ptd.ts        #   entry point
│   ├── cli/                     # yt2pt — REST client for the daemon
│   │   ├── src/api/             #   fetch wrapper + SSE consumer
│   │   ├── src/commands/        #   one module per command
│   │   └── src/output/          #   format, table, progress, time
│   └── web/                     # @yt2pt/web — Vue 3 SPA (Vite)
├── yt2pt.conf.example.toml
├── package.json                 # npm workspaces
└── tsconfig.base.json
```

## Runtime components

### yt2ptd (daemon)

1. Loads config + resolves paths (`loadConfig`, `resolvePaths`).
2. Opens SQLite database under `data_dir/yt2pt.db` (migrations live in
   `packages/daemon/src/db/migrations/`).
3. Starts a `PeertubeConnection` — authenticates, polls instance status.
4. Constructs the job queue + download/convert/upload processors.
5. Starts the `SyncEngine` that walks channels, discovers new videos via
   `yt-dlp`, and enqueues them.
6. Builds the Fastify app, registers routes, serves the bundled Web UI
   from `packages/web/dist/`.
7. Listens on `[http] port`.

### Job queue

An in-process, per-processor queue backed by the DB. Each video row
carries a status (`DISCOVERED` → `DOWNLOADING` → `DOWNLOADED` →
`CONVERTING` → `CONVERTED` → `UPLOADING` → `UPLOADED`, plus `FAILED`).
Processors emit `status-change` and `progress` events that the SSE
stream relays.

### Sync engine

`SyncEngine.trigger(channelId)` kicks off a single, per-channel sync:
discover videos via yt-dlp, diff against the DB, enqueue new ones, emit
`sync-started` / `sync-progress` / `sync-completed` / `sync-failed`
events. Concurrent triggers for the same channel return
`in_progress`; a per-channel cooldown returns `rate_limited`.

### REST / SSE surface

See [api.md](api.md). Routes are grouped under `packages/daemon/src/routes/`
and registered by `server.ts`.

### Web UI

Vite + Vue 3 + vue-router + Pico CSS. Built to `packages/web/dist/` and
served by the daemon via `@fastify/static` (SPA fallback to
`index.html`). In dev mode, run `npm run dev:web` and it proxies API
calls to the local daemon.

### CLI

The CLI does no heavy lifting. It:

- parses argv (dependency-free `argv.ts`);
- talks to the daemon via a small `fetch` wrapper (`api/client.ts`);
- consumes `/api/events` for live `channels sync` (`api/sse.ts`);
- renders human or JSON output (`output/format.ts`, `table.ts`, `progress.ts`).

## Path resolution

Paths and config location depend on the "mode":

- **root** — `/etc/yt2pt/yt2pt.conf.toml` exists (system install).
- **user** — Linux user-local fallback under XDG.
- **dev** — macOS, or a `yt2pt.conf.toml` exists in the repo root.

Precedence (highest wins): config file values > environment variables
(`YT2PT_CONFIG`, `YT2PT_DATA_DIR`, `YT2PT_LOG_DIR`) > per-mode defaults.

See `packages/shared/src/paths.ts`.

## Process model

A single `yt2ptd` Node.js process hosts everything: HTTP server, DB
access, queue, sync engine, and subprocess invocations of `yt-dlp` /
`ffmpeg`. SQLite is accessed in-process via `better-sqlite3` (synchronous,
serialised at the engine level).

On shutdown (`SIGTERM` / `SIGINT`) the daemon stops the PeerTube poller,
halts the sync engine, drains the queue, closes Fastify, and closes the
DB handle.
