# Development setup

## Prerequisites

- **Node.js ≥ 22** (nvm is fine — nothing system-wide is required for dev).
- **ffmpeg** (used by `yt-dlp`).
- A Unix-like shell.

## Clone and build

```bash
git clone https://github.com/jloup83/yt2pt.git
cd yt2pt
npm install
npm run build:all
```

This builds `@yt2pt/shared`, `@yt2pt/daemon`, `yt2pt` (the CLI), and the
Web UI (`@yt2pt/web`).

Common scripts:

| Command | What it does |
|---------|--------------|
| `npm run build`       | TypeScript project references: shared + daemon + cli |
| `npm run build:web`   | Vite build for the Web UI |
| `npm run build:all`   | Both of the above |
| `npm run clean`       | `tsc -b --clean` |
| `npm test`            | Run tests in every workspace that has them |
| `npm run dev:web`     | Vite dev server for the Web UI (HMR) |

## Dev-mode paths

On macOS, or when a `yt2pt.conf.toml` exists in the repo root, the
daemon runs in **dev mode**:

- config: `<repo>/yt2pt.conf.toml`
- data:   `/tmp/yt2ptd/data`
- logs:   `/tmp/yt2ptd/logs`
- bin:    `<repo>/bin`

Create a dev config:

```bash
cp yt2pt.conf.example.toml yt2pt.conf.toml
# edit as needed
```

## Running the daemon from the repo

```bash
# Build once, then run the compiled entry point directly:
node packages/daemon/dist/yt2ptd.js
```

Or via the CLI's bin script:

```bash
node packages/cli/dist/index.js status
```

## Running the Web UI in dev mode

```bash
# terminal 1: daemon
node packages/daemon/dist/yt2ptd.js

# terminal 2: vite dev server (with HMR, proxies /api to localhost:8090)
npm run dev:web
```

Open the URL Vite prints (typically `http://localhost:5173`).

## Tests

```bash
npm test                                             # every workspace
npm --workspace @yt2pt/daemon test                   # daemon only
npm --workspace yt2pt          test                  # CLI only
npm --workspace @yt2pt/shared  test                  # shared only
```

Tests are `node:test`-based, co-located as `*.test.ts`, and run through `tsx`.

## Project layout

See [architecture.md](architecture.md) for a tour of the monorepo.

## Branching and release workflow

- **`main`** — release-only. Only receives merge PRs for tagged releases.
- **`vX.Y.Z-beta`** — milestone dev branches where all work for a
  milestone lands. Example: `v1.0.0-beta`.
- **`feat/<n>-slug`** or **`fix/<n>-slug`** — issue branches off the
  current beta branch, named after the GitHub issue.

Workflow for an open issue:

1. `git checkout vX.Y.Z-beta && git pull`
2. `git checkout -b feat/<n>-slug`
3. Implement, commit (signed), push.
4. `gh pr create --base vX.Y.Z-beta --head feat/<n>-slug`
5. Reviewer merges.
6. When all milestone issues are done, a release PR goes from
   `vX.Y.Z-beta` → `main` with a version bump and tag.

## Linting and type-checking

- TypeScript project references — `tsc -b` checks every workspace.
- Web UI: `npm --workspace @yt2pt/web run typecheck` runs `vue-tsc --noEmit`.

## Debugging the systemd service with a dev build

After `sudo ./deploy/install.sh`, you can drop in a test build without
rebuilding node_modules:

```bash
npm run build:all
sudo ./deploy/install.sh     # idempotent, re-copies packages/*/dist
sudo systemctl restart yt2ptd.service
journalctl -u yt2ptd.service -f
```
