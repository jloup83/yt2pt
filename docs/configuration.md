# Configuration reference

The daemon loads `yt2pt.conf.toml` at startup. Location depends on the
path mode (see [installation.md](installation.md)):

| Mode | Path |
|------|------|
| root | `/etc/yt2pt/yt2pt.conf.toml` |
| user | `~/.config/yt2pt/yt2pt.conf.toml` |
| dev | `<repo>/yt2pt.conf.toml` |

Override with `YT2PT_CONFIG=/path/to/yt2pt.conf.toml`.

Changes take effect after a daemon restart (`sudo systemctl restart yt2ptd`).

---

## `[yt2pt]` — paths and general options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `data_dir` | string | mode-specific | Where videos and the SQLite DB live. |
| `log_dir`  | string | mode-specific | Where `yt2pt.log` is written. |
| `log_level` | string | `info` | `error` \| `info` \| `debug`. |
| `overwrite_existing` | bool | `false` | Re-download already-present files. |
| `skip_downloaded` | bool | `true` | Skip videos already in the DB. |
| `remove_video_after_upload` | bool | `false` | Delete local video after successful upload. |
| `remove_video_after_metadata_conversion` | bool | `false` | Delete the downloaded video after the convert step. |

Default paths per mode:

| Mode | `data_dir` | `log_dir` |
|------|-----------|-----------|
| root | `/var/lib/yt2pt` | `/var/log/yt2pt` |
| user | `~/.local/share/yt2pt` | `~/.local/share/yt2pt/logs` |
| dev  | `/tmp/yt2ptd/data` | `/tmp/yt2ptd/logs` |

Environment overrides (lowest priority; config file wins):

- `YT2PT_DATA_DIR`
- `YT2PT_LOG_DIR`

---

## `[http]` — HTTP server

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `port` | int | `8090` | Listening port. |
| `bind` | string | `0.0.0.0` | Interface to bind. Use `127.0.0.1` for localhost-only. |

---

## `[workers]` — concurrency

Keep these small; yt-dlp and PeerTube are rate-sensitive.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `download_concurrency` | int | `1` | Parallel yt-dlp downloads. |
| `convert_concurrency`  | int | `1` | Parallel metadata conversions. |
| `upload_concurrency`   | int | `1` | Parallel PeerTube uploads. |

---

## `[ytdlp]` — yt-dlp options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `format` | string | `bv*[height<=1080]+ba/b[height<=1080]` | yt-dlp format selector. Use `bv*+ba/b` for max quality. |
| `merge_output_format` | string | `mkv` | Container for merged video+audio. |
| `thumbnail_format` | string | `jpg` | Thumbnail format yt-dlp should emit. |

---

## `[peertube]` — PeerTube target

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `instance_url` | string | `""` | Full URL, e.g. `https://peertube.example.com`. |
| `api_token` | string | `""` | OAuth access token (set via `yt2pt token …`). Sensitive; redacted from API output. |
| `channel_id` | string | `""` | Default target channel id if a mapping doesn't override it. |
| `privacy` | string | `public` | `public` \| `unlisted` \| `private` \| `internal` \| `password_protected`. |
| `language` | string | `""` | Two-letter language code for uploaded videos. |
| `licence` | string | `""` | License label, e.g. `Attribution - Share Alike`. |
| `comments_policy` | string | `enabled` | `enabled` \| `disabled` \| `requires_approval`. |
| `wait_transcoding` | bool | `true` | Block until PeerTube finishes transcoding. |
| `generate_transcription` | bool | `true` | Ask PeerTube to generate subtitles. |

> `api_token` expires periodically. Regenerate with:
> ```bash
> yt2pt token <username> <password>
> ```
> This persists the new token to the config file atomically.

---

## Example

A minimal production config after install:

```toml
[yt2pt]
log_level = "info"

[http]
port = 8090
bind = "127.0.0.1"

[peertube]
instance_url = "https://peertube.example.com"
api_token    = "…set by `yt2pt token`…"
privacy      = "unlisted"
language     = "en"
```

---

## Environment variables

| Variable | Purpose |
|----------|---------|
| `YT2PT_CONFIG` | Override config file path. |
| `YT2PT_DATA_DIR` | Override data directory. |
| `YT2PT_LOG_DIR` | Override log directory. |
| `YT2PT_DAEMON_URL` | CLI default daemon URL. |
| `YT2PT_WEB_ROOT` | Path to the built Web UI (rarely needed). |
| `NO_COLOR` / `YT2PT_NO_COLOR` | Disable colored CLI output. |
