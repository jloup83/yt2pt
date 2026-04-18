# yt2pt

Download YouTube videos with full metadata, subtitles, and channel info — organized for PeerTube migration.

**Supported platforms:** macOS (Intel & Apple Silicon), Linux (x86_64)

## Prerequisites

- **Python 3.10+** — check with `python3 --version`
  - macOS: comes pre-installed, or install from [python.org](https://www.python.org/downloads/)
  - Linux: `sudo apt install python3` (Debian/Ubuntu) or `sudo dnf install python3` (Fedora)
- **yt-dlp binary** — already included in this repo (`yt-dlp-macos-*` / `yt-dlp-linux-*`)
- **ffmpeg** — required by yt-dlp for merging video + audio into MKV
  - macOS: `brew install ffmpeg`
  - Linux: `sudo apt install ffmpeg`

## Setup

### Option A: Shell alias (recommended)

Add this to your `~/.zshrc` or `~/.bashrc`:

```bash
alias yt2pt='python3 /Users/jean-loup/Engineering/yt2pt/yt2pt.py'
```

Then reload your shell:

```bash
source ~/.zshrc
```

### Option B: Direct invocation

```bash
python3 yt2pt.py download
```

## Usage

```
yt2pt download              # Download all videos listed in list.txt
yt2pt download --overwrite   # Re-download even if already present
yt2pt --version              # Show version
yt2pt -h                     # Show help
```

## How it works

### 1. Add URLs to `list.txt`

Create a file called `list.txt` in the same directory as the script (it will be auto-created with an example on first run). Add one YouTube video URL per line:

```
# This is a comment — lines starting with '#' are ignored.
# Empty lines are also ignored.

https://www.youtube.com/watch?v=eot4NJwbr3M
https://www.youtube.com/watch?v=dQw4w9WgXcQ
```

### 2. Run the download

```bash
yt2pt download
```

### 3. Output folder structure

Each video is saved under `downloads/` with the following layout:

```
downloads/
└── Channel_Name/
    └── Channel_Name_2024-01-15_Video_Title/
        ├── Channel_Name_2024-01-15_Video_Title.mkv   # Video (best ≤ 1080p + best audio)
        ├── youtube/
        │   ├── metadata.json      # Full video metadata (title, description, chapters, etc.)
        │   ├── thumbnail.jpeg     # Video thumbnail
        │   └── subtitles/         # Manual subtitles (no auto-generated)
        │       ├── subtitle.en.vtt
        │       └── subtitle.fr.vtt
        └── channel/
            ├── metadata.json      # Channel metadata
            ├── avatar.jpeg        # Channel profile picture
            └── banner.jpeg        # Channel banner image
```

**Naming convention:** `ChannelName_YYYY-MM-DD_VideoTitle`

- Filesystem-unsafe characters (`/ \ : * ? " < > |`) are replaced with `_`
- Titles are truncated to 100 characters to avoid path length issues

### Skip / Overwrite behavior

- **Default:** if a video folder already exists, it is skipped
- Use `--overwrite` to force re-downloading

## Logs

All yt-dlp commands are printed in full for debugging. Logs are color-coded when running in a terminal:

- `ℹ` Info (blue)
- `✔` Success (green)
- `⚠` Warning (yellow)
- `✖` Error (red)
- `$` Command (magenta)

## Examples

Download all videos in `list.txt`:

```bash
$ yt2pt download
  ℹ  Using yt-dlp: yt-dlp-macos-v2026.03.17
  ℹ  Found 2 URL(s) in list.txt
  ℹ  [1/2] Line 4: https://www.youtube.com/watch?v=eot4NJwbr3M

  ▸ Fetching video metadata
  $ /path/to/yt-dlp-macos-v2026.03.17 --dump-json --no-download ...

════════════════════════════════════════════════════════════════
  SomeChannel  ·  2024-03-15  ·  Some Video Title
════════════════════════════════════════════════════════════════

  ▸ Downloading video (MKV, ≤ 1080p)
  $ /path/to/yt-dlp-macos-v2026.03.17 -f bestvideo[height<=1080]+bestaudio ...
  ✔  Video saved (142.3 MB)
  ...
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `command not found: yt2pt` | Set up the alias (see [Setup](#setup)) or run `python3 yt2pt.py` directly |
| `No yt-dlp binary found` | Ensure `yt-dlp-macos-*` or `yt-dlp-linux-*` exists in the script directory |
| `ffmpeg not found` / merge fails | Install ffmpeg: `brew install ffmpeg` (macOS) or `sudo apt install ffmpeg` (Linux) |
| Video file not found after download | Check the yt-dlp error output — the format might not be available at ≤ 1080p |
| No manual subtitles | The video has no human-uploaded subtitles (auto-generated are excluded by design) |

## License

See [LICENSE](LICENSE).
