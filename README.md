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

## Usage

```bash
# Show help
yt2pt -h

# Show version
yt2pt -v

# Download a video
yt2pt https://www.youtube.com/watch?v=q5Mq4kEa7pA
```

## What it does

Given a YouTube URL, yt2pt will:

1. **Download the video** in best available quality (audio + video muxed into MKV)
2. **Download the thumbnail** in best available quality (converted to JPG)
3. **Create a `metadata.json`** with essential video information

## Folder structure

All downloads are stored under a `downloads/` directory:

```text
downloads/
└── {CHANNEL_NAME}/
    └── {CHANNEL_NAME}_{PUBLISHED_DATE}_{VIDEO_TITLE}_{[VIDEO_ID]}/
        ├── metadata.json
        ├── thumbnail.jpg
        └── {CHANNEL_NAME}_{PUBLISHED_DATE}_{VIDEO_TITLE}_{[VIDEO_ID]}.mkv
```

### Example

```text
downloads/
└── fatherphi/
    └── fatherphi_2026-01-29_day_6_maybe_the_chatgpt_limit_really_is_just_200_now_[q5Mq4kEa7pA]/
        ├── metadata.json
        ├── thumbnail.jpg
        └── fatherphi_2026-01-29_day_6_maybe_the_chatgpt_limit_really_is_just_200_now_[q5Mq4kEa7pA].mkv
```

## metadata.json

```json
{
  "channel": "FatherPhi",
  "channel_id": "UCIw9p-0zI1rEPEs_SS6fDkg",
  "channel_url": "https://www.youtube.com/channel/UCIw9p-0zI1rEPEs_SS6fDkg",
  "id": "q5Mq4kEa7pA",
  "title": "Day 6… 🫩 maybe the #chatgpt limit really is just 200 now",
  "ext": "mkv",
  "description": "...",
  "upload_date": "20260129",
  "video_url": "https://www.youtube.com/watch?v=q5Mq4kEa7pA",
  "duration": 59,
  "duration_string": "59",
  "language": "en",
  "categories": ["Entertainment"],
  "tags": [],
  "thumbnail": "thumbnail.jpg"
}
```

| Field | Description |
| ----- | ----------- |
| `channel` | Full name of the YouTube channel |
| `channel_id` | Channel identifier |
| `channel_url` | URL of the channel |
| `id` | YouTube video ID |
| `title` | Video title |
| `ext` | Video file extension |
| `description` | Video description |
| `upload_date` | Upload date in UTC (YYYYMMDD) |
| `video_url` | YouTube video URL |
| `duration` | Video duration in seconds |
| `duration_string` | Human-readable video duration |
| `language` | Video language (e.g. `"en"`) |
| `categories` | YouTube categories |
| `tags` | YouTube tags |
| `thumbnail` | Filename of the thumbnail in the same folder |

## Contributing

### Dev environment setup

```bash
git clone https://github.com/jloup83/yt2pt.git
cd yt2pt
npm install
npm run build
```

### Run locally without installing globally

```
node dist/index.js
```

### Or install globally as "yt2pt"

```
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
