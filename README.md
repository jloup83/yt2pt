# yt2pt

**Automated YouTube → PeerTube migration, as a long-running daemon with a
Web UI, CLI, and REST API.**

yt2pt watches a set of YouTube channels you care about, downloads each new
video with `yt-dlp` (metadata, thumbnail, subtitles, chapters), and uploads
them to the matching channels on your PeerTube instance. It runs as a
system service on Linux, or as a local dev process on macOS / Linux.

---

## Architecture

```
                ┌───────────────────────────────┐
                │        yt2ptd (daemon)        │
                │  ┌─────────────────────────┐  │
 Web UI ──────► │  │  Fastify HTTP + SSE     │  │ ◄──── CLI (yt2pt)
 (bundled)      │  └───────┬─────────────────┘  │       curl / any client
                │          │                    │
                │  ┌───────▼──────┐  ┌───────┐  │
                │  │  SQLite DB   │  │ Queue │  │
                │  └──────────────┘  └───┬───┘  │
                │                        │      │
                │        ┌───────────────▼───┐  │
                │        │ download/convert/ │  │
                │        │   upload workers  │  │
                │        └─────────┬─────────┘  │
                └──────────────────┼────────────┘
                                   │
                          yt-dlp ──┴── PeerTube API
```

- **Daemon (`yt2ptd`)** — Fastify server, SQLite state, background queue,
  sync engine, worker pool.
- **Web UI** — Vue SPA, bundled with the daemon and served from `/`.
- **CLI (`yt2pt`)** — thin REST client for the daemon; also consumes the
  SSE stream for live sync progress.
- **REST API** — `GET /api/health`, `/api/settings`, `/api/peertube/…`,
  `/api/channels…`, `/api/videos…`, `/api/events` (SSE).

See [docs/architecture.md](docs/architecture.md) for more detail.

---

## Supported platforms

| Platform | Role |
|----------|------|
| **Linux x86_64** | Production install (systemd service) **and** dev |
| **macOS (Intel / Apple Silicon)** | Dev only (runs in dev-mode paths) |

`yt-dlp` binaries for Linux and macOS are bundled in `bin/`.

---

## Quick start (Linux, system install)

### 1. Prerequisites

- **Node.js ≥ 22** installed **system-wide** (not under `$HOME`/nvm — the
  daemon runs as a dedicated user and cannot read your home directory).
- **ffmpeg** (required by `yt-dlp` to merge audio + video).
- Build tools to compile `better-sqlite3` on first `npm ci`.

```bash
# Debian / Ubuntu / Kubuntu:
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs ffmpeg build-essential
```

### 2. Build

```bash
git clone https://github.com/jloup83/yt2pt.git
cd yt2pt
npm ci
npm run build:all
```

### 3. Install

```bash
sudo ./deploy/install.sh
```

This creates the `yt2pt` system user, lays files under `/usr/local`,
`/etc/yt2pt`, `/var/lib/yt2pt`, `/var/log/yt2pt`, and installs the
`yt2ptd.service` unit.

### 4. Configure PeerTube credentials

```bash
sudoedit /etc/yt2pt/yt2pt.toml          # set instance_url
yt2pt token <your-peertube-username> <your-password>
```

### 5. Start the daemon

```bash
sudo systemctl enable --now yt2ptd.service
yt2pt status
```

### 6. Add a channel and sync

Either use the Web UI at `http://<host>:8090`, or the CLI:

```bash
yt2pt channels add https://www.youtube.com/@SomeChannel <peertube-channel-id>
yt2pt channels sync <channel-id>    # streams live progress
```

---

## Documentation

| Topic | File |
|-------|------|
| Install / upgrade / uninstall | [docs/installation.md](docs/installation.md) |
| systemd service management & logs | [docs/service.md](docs/service.md) |
| Configuration reference | [docs/configuration.md](docs/configuration.md) |
| CLI reference | [docs/cli.md](docs/cli.md) |
| Web UI guide | [docs/web-ui.md](docs/web-ui.md) |
| REST API + SSE events | [docs/api.md](docs/api.md) |
| Architecture | [docs/architecture.md](docs/architecture.md) |
| Development setup | [docs/development.md](docs/development.md) |
| Troubleshooting | [docs/troubleshooting.md](docs/troubleshooting.md) |

---

## License

See [LICENSE](LICENSE).
# yt2pt

Download YouTube videos with metadata and thumbnails, organized for PeerTube migration.

**Supported platforms:** macOS (Intel & Apple Silicon), Linux (x86_64)

## Prerequisites

- **Node.js** (v18+)
- **ffmpeg** — required by yt-dlp to merge audio + video streams

The yt-dlp binaries for macOS and Linux are bundled in the `bin/` directory.

### macOS

```bash
# Install Homebrew (if not already installed)
curl -o- https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | bash

# Install Node.js and ffmpeg
brew install node@24 ffmpeg

# Verify
node -v  # Should print "v24.14.1"
npm -v   # Should print "11.11.0"
```

### Linux

```bash
# Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash

# Load nvm (in lieu of restarting the shell)
\. "$HOME/.nvm/nvm.sh"

# Install Node.js
nvm install 24

# Verify
node -v  # Should print "v24.14.1"
npm -v   # Should print "11.11.0"

# Install ffmpeg
sudo apt install ffmpeg        # Debian/Ubuntu
# or
sudo dnf install ffmpeg        # Fedora
```

## Setup

```bash
git clone https://github.com/jloup83/yt2pt.git
cd yt2pt
npm install
npm run build
npm link
```

This creates a global `yt2pt` command you can use from anywhere.

> **Tip:** If tab completion doesn't work right away (typing `yt` + Tab),
> run `rehash` in your terminal or open a new terminal window.

To remove it later: `npm unlink -g yt2pt`

### Linux — ensure the binary is executable

```bash
chmod +x bin/yt-dlp-linux-*
```

## PeerTube Authentication

Before uploading videos, you need to configure your PeerTube credentials in `yt2pt.toml`.

### 1. Create your config file

```bash
./deploy/install.sh --development
# or manually: cp yt2pt.development.toml yt2pt.toml
```

Set your instance URL:

```toml
[peertube]
instance_url = "https://your-instance.example.com"
```

### 2. Get your API token

PeerTube uses OAuth2 for authentication. You need to obtain an access token.

**Prerequisites:** `curl` and `jq` must be installed.

**One-liner** (replace the URL, enter your username and password when prompted):

```bash
API="https://your-instance.example.com/api/v1" && \
  printf "Username: " && read USER && \
  printf "Password: " && stty -echo && read PASS && stty echo && echo && \
  CLIENT=$(curl -s "$API/oauth-clients/local") && \
  TOKEN=$(curl -s "$API/users/token" \
    --data client_id="$(echo "$CLIENT" | jq -r .client_id)" \
    --data client_secret="$(echo "$CLIENT" | jq -r .client_secret)" \
    --data grant_type=password \
    --data username="$USER" \
    --data-urlencode password="$PASS" \
    | jq -r .access_token) && \
  sed -i.bak -E "s|^api_token = .*|api_token = \"$TOKEN\"|" yt2pt.toml && rm yt2pt.toml.bak && \
  echo "Token set successfully"
```

**Or manually:**

1. Get the OAuth client credentials:

   ```bash
   curl -s https://your-instance.example.com/api/v1/oauth-clients/local | jq
   ```

2. Get an access token:

   ```bash
   curl -s https://your-instance.example.com/api/v1/users/token \
     --data client_id="YOUR_CLIENT_ID" \
     --data client_secret="YOUR_CLIENT_SECRET" \
     --data grant_type=password \
     --data username="YOUR_USERNAME" \
     --data-urlencode password="YOUR_PASSWORD" \
     | jq -r .access_token
   ```

3. Copy the token into `yt2pt.toml`:

   ```toml
   [peertube]
   api_token = "YOUR_ACCESS_TOKEN"
   ```

> **Note:** Access tokens expire after ~4 hours. You will need to regenerate the token when it expires.

### 3. Get your channel ID

```bash
curl -s https://your-instance.example.com/api/v1/accounts/YOUR_USERNAME/video-channels | jq '.data[] | {id, name, displayName}'
```

Set the channel ID in your config:

```toml
[peertube]
channel_id = "YOUR_CHANNEL_ID"
```

## Usage

```bash
# Show help
yt2pt -h

# Show version
yt2pt -v

# Download a video from YouTube
yt2pt 'https://www.youtube.com/watch?v=VIDEO_ID'

# Download only (no conversion or upload)
yt2pt 'https://www.youtube.com/watch?v=VIDEO_ID' --download-only

# Convert all downloaded metadata for PeerTube
yt2pt --convert-metadata

# Upload all converted videos to PeerTube
yt2pt --upload-only
```

> **Tip:** Always quote YouTube URLs in your shell to avoid issues with the `?` character.

## Pipeline

yt2pt works in three phases:

1. **Download** — Fetches video, thumbnail, subtitles, and raw metadata from YouTube
2. **Convert** — Transforms YouTube metadata into PeerTube-ready API files
3. **Upload** — Sends everything to your PeerTube instance

### Folder structure

All data is stored under a `data/` directory (configurable via `data_dir`):

```text
data/
├── downloaded_from_youtube/
│   └── {channel}/
│       └── {channel}_{date}_{title}_[{id}]/
│           ├── metadata.json          # Raw yt-dlp metadata
│           ├── video.mkv
│           ├── thumbnail.jpg
│           └── subtitles/
│               └── {id}.{lang}.vtt
└── upload_to_peertube/
    └── {channel}/
        └── {channel}_{date}_{title}_[{id}]/
            ├── upload_video.json      # Video upload metadata
            ├── set_thumbnail.json     # Thumbnail file reference
            ├── upload_subtitles.json  # Subtitle files (if any)
            ├── set_chapters.json      # Chapter markers (if any)
            ├── video.mkv
            ├── thumbnail.jpg
            └── subtitles/
                └── {id}.{lang}.vtt
```

## Contributing

### Dev environment setup

```bash
git clone https://github.com/jloup83/yt2pt.git
cd yt2pt
npm install
npm run build
```

### Run locally without installing globally

```bash
node dist/index.js
```

### Or install globally as "yt2pt"

```bash
npm link
```

### Branching model

- **`main`** — Release-only branch. Only receives merge PRs for releases (tagged). Never commit directly.
- **`vX.X.X-beta`** — Milestone dev branches (e.g. `v0.1.0-beta`). All implementation work for a milestone happens here.
- **Issue branches** — Created off the relevant `vX.X.X-beta` branch, named after the issue (e.g. `17-audit-metadata`), with a PR back into that beta branch.

### Workflow

1. Pick an open issue from a milestone
2. Create a branch off the corresponding `vX.X.X-beta` branch
3. Implement, commit (signed commits required), push
4. Open a PR targeting the `vX.X.X-beta` branch
5. Integrator reviews and merges
6. When all milestone issues are done, integrator creates a release PR from `vX.X.X-beta` → `main` with version bump, tag, and release notes
