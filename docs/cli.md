# CLI reference

The `yt2pt` CLI is a thin REST client for the daemon. It never touches
`yt-dlp`, the DB, or PeerTube directly — everything goes through
`http://localhost:8090` (by default).

## Global flags

| Flag | Description |
|------|-------------|
| `--daemon-url=<url>` | Override daemon URL. Default `http://localhost:8090`. |
| `--json` | Emit machine-readable JSON instead of human output. |
| `-h`, `--help` | Show help. |
| `-v`, `--version` | Show version. |

Environment:

- `YT2PT_DAEMON_URL` — default daemon URL.
- `NO_COLOR` / `YT2PT_NO_COLOR` — disable colors.

Exit codes:

- `0` success
- `1` API error, invalid arguments, or unexpected failure
- `2` daemon unreachable

---

## `yt2pt status`

Daemon + PeerTube connection status.

```text
$ yt2pt status
Daemon:    online  http://localhost:8090
Version:   1.0.0-beta
PeerTube:  online  https://peertube.example.com
Auth:      authenticated as alice
```

`yt2pt status --json` emits the raw `/api/health` + `/api/peertube/status`.

---

## `yt2pt config`

### Show current config

```bash
yt2pt config
```

Prints the full TOML config with `api_token` redacted.

### Set a value

```bash
yt2pt config <section.key> <value>
yt2pt config peertube.privacy unlisted
yt2pt config http.port 9000
yt2pt config yt2pt.log_level debug
```

Values are coerced to the correct type (bool / int / string). After
changes, restart the daemon for them to take effect:

```bash
sudo systemctl restart yt2ptd
```

---

## `yt2pt token <username> <password>`

Acquire a PeerTube OAuth token and persist it into the config.

```bash
yt2pt token alice 's3cret!'
```

The token is written to `[peertube] api_token`. Tokens expire — rerun
this command when `yt2pt status` reports `not authenticated`.

---

## `yt2pt channels …`

Manage YouTube → PeerTube channel mappings.

### `channels list`

```bash
yt2pt channels list
```

Shows each mapping with its last sync status and video counts by state.

### `channels add <yt-url> <pt-channel-id>`

```bash
yt2pt channels add https://www.youtube.com/@SomeChannel 42
```

The URL is normalised. The daemon attempts (best-effort) to resolve the
channel name via yt-dlp.

### `channels remove <id>`

```bash
yt2pt channels remove 3
yt2pt channels rm 3    # alias
```

Deletes the mapping. Tracked videos are kept.

### `channels sync <id>`

```bash
yt2pt channels sync 3
```

Triggers a sync for the channel and **streams live progress** from the
daemon's SSE stream. The display redraws as each phase (discover, queue,
download, convert, upload) advances.

Use `--no-watch` to fire-and-return without streaming:

```bash
yt2pt channels sync 3 --no-watch
```

Exit codes:

- `202` accepted → CLI exits `0` once sync completes
- `409` already in progress → exit `1`
- `429` rate limited → exit `1`, prints `Retry-After`

---

## `yt2pt videos`

List tracked videos from the DB.

```bash
yt2pt videos
yt2pt videos --status=UPLOADING
yt2pt videos --channel=3
yt2pt videos --page=2 --per-page=50
yt2pt videos --json
```

Common `--status` values: `DISCOVERED`, `DOWNLOADING`, `DOWNLOADED`,
`CONVERTING`, `CONVERTED`, `UPLOADING`, `UPLOADED`, `FAILED`.

---

## Help

```bash
yt2pt help
yt2pt --help
yt2pt -h
```
