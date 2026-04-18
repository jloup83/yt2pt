# Installation

yt2pt supports three path modes:

| Mode | Trigger | Config path | Data dir | Log dir |
|------|---------|-------------|----------|---------|
| **root** | `/etc/yt2pt/yt2pt.toml` exists (system install) | `/etc/yt2pt/yt2pt.toml` | `/var/lib/yt2pt` | `/var/log/yt2pt` |
| **user** | Linux, non-root, no system config | `~/.config/yt2pt/yt2pt.toml` | `~/.local/share/yt2pt` | `~/.local/share/yt2pt/logs` |
| **dev** | macOS, *or* a `yt2pt.toml` exists at the repo root | `<repo>/yt2pt.toml` | `~/.local/share/yt2pt` | `~/.local/share/yt2pt/logs` |

This page covers the **root** install on Linux. For running from a clone
without installing, see [`development.md`](development.md).

## Prerequisites

- Linux x86_64
- Node.js ≥ 22 installed **system-wide** (not under `$HOME`/nvm)
- ffmpeg
- Build tools (`build-essential` on Debian/Ubuntu) to compile
  `better-sqlite3` on first `npm ci`

```bash
# Debian / Ubuntu / Kubuntu:
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs ffmpeg build-essential

# Fedora:
sudo dnf install -y nodejs ffmpeg make gcc gcc-c++ python3
```

> **Why system-wide node?** The daemon runs as the dedicated `yt2pt`
> user under `systemd`'s `ProtectHome=true`. A node installed under
> your own `$HOME` (nvm) is invisible to the service. The installer
> refuses to proceed in that case.

## Install

From a clone of the repository:

```bash
git clone https://github.com/jloup83/yt2pt.git
cd yt2pt
npm ci
npm run build:all
sudo ./deploy/install.sh
```

The installer:

- creates the `yt2pt` system user and group (no login shell, no home);
- creates `/etc/yt2pt`, `/var/lib/yt2pt`, `/var/log/yt2pt`, and
  `/usr/local/lib/yt2pt/{app,bin}`;
- copies `packages/*/dist` and the root `node_modules` to
  `/usr/local/lib/yt2pt/app/`;
- installs the bundled Linux `yt-dlp` to `/usr/local/lib/yt2pt/bin/`;
- writes shell wrappers at `/usr/local/bin/yt2pt` and
  `/usr/local/bin/yt2ptd` that invoke the system node with absolute paths;
- copies `yt2pt.production.toml` to `/etc/yt2pt/yt2pt.toml`
  **only if that file does not already exist** (existing configs are never
  overwritten);
- installs `deploy/yt2ptd.service` and runs `systemctl daemon-reload`.

The installer is **idempotent** — rerun it to pick up new builds.

## Upgrade

```bash
cd yt2pt
git pull
npm ci
npm run build:all
sudo ./deploy/install.sh
sudo systemctl restart yt2ptd.service
```

Your `/etc/yt2pt/yt2pt.toml` is preserved.

## Uninstall

Keep config, data, logs, and the `yt2pt` user:

```bash
sudo ./deploy/uninstall.sh
```

Remove everything (config, data, logs, user/group):

```bash
sudo ./deploy/uninstall.sh --purge
```

## Files and directories

```
/usr/local/bin/yt2pt              # CLI wrapper (calls node + cli dist)
/usr/local/bin/yt2ptd             # daemon wrapper
/usr/local/lib/yt2pt/app/         # bundled workspace payload
/usr/local/lib/yt2pt/bin/         # bundled yt-dlp
/etc/yt2pt/yt2pt.toml        # config (root:yt2pt, mode 0640)
/etc/systemd/system/yt2ptd.service
/var/lib/yt2pt/                   # SQLite DB, downloaded + staged videos
/var/log/yt2pt/                   # yt2pt.log (rotated at startup)
```

## Running without installing (user / dev mode)

See [`development.md`](development.md).
