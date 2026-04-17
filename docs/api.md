# REST API + SSE events

Base URL: `http://<host>:8090` (default). All responses are JSON unless
otherwise noted.

## Authentication

The daemon has **no authentication**. Bind to `127.0.0.1` (`[http] bind`)
and put it behind a reverse proxy if you need auth on the network path.

## Health

### `GET /api/health`

```json
{ "status": "ok", "version": "1.0.0-beta", "uptime_s": 142 }
```

## Settings

### `GET /api/settings`

Returns the full config with sensitive fields (`api_token`) redacted.

### `PUT /api/settings`

Body: a partial config object matching the TOML structure. Writes the
merged result to `yt2pt.conf.toml` atomically. Most changes apply
immediately; some (bind, port) require a restart.

### `POST /api/settings/token`

```json
{ "username": "alice", "password": "s3cret!" }
```

Acquires an OAuth token from PeerTube and persists it into
`[peertube].api_token`. Returns the new (redacted) settings.

## PeerTube

### `GET /api/peertube/status`

```json
{
  "instance_url": "https://peertube.example.com",
  "online": true,
  "authenticated": true,
  "username": "alice"
}
```

### `GET /api/peertube/channels`

Lists channels on the authenticated PeerTube account. Used by the Web
UI when adding a mapping.

## Channels (mappings)

### `GET /api/channels`

```json
{ "channels": [
  {
    "id": 3,
    "youtube_channel_url": "https://www.youtube.com/@SomeChannel",
    "youtube_channel_name": "Some Channel",
    "peertube_channel_id": "42",
    "video_count": 117,
    "status_summary": { "UPLOADED": 110, "FAILED": 2, "QUEUED": 5 }
  }
]}
```

### `POST /api/channels`

```json
{
  "youtube_channel_url": "https://www.youtube.com/@SomeChannel",
  "peertube_channel_id": "42"
}
```

Responses:

- `201` — created, returns the full row
- `400` — missing/invalid URL or id
- `409` — channel already mapped

### `DELETE /api/channels/:id`

Responses: `204` | `400` | `404`.

### `POST /api/channels/:id/sync`

Kicks off a sync.

- `202` — `{ "status": "started", "channel_id": 3 }`
- `409` — already syncing
- `429` — rate-limited; includes `Retry-After` header and `retry_after_s` in body
- `503` — sync engine unavailable

Watch progress via `/api/events`.

## Videos

### `GET /api/videos`

Query parameters:

- `status` — filter by status (e.g. `UPLOADING`, `FAILED`)
- `channel` — filter by channel id
- `page` (default `1`), `per_page` (default `50`)

Returns `{ videos: [...], total, page, per_page }`.

### `GET /api/videos/:id`

Single video, including yt-dlp metadata and PeerTube upload info.

## Events (SSE)

### `GET /api/events`

Content type `text/event-stream`. Long-lived. A `retry: 5000` hint and a
`hello` event are sent on connect, plus a `: ping` heartbeat comment
every few seconds.

Event types:

| Event | Payload |
|-------|---------|
| `hello` | `{ ts: ISO-8601 }` |
| `peertube_status` | same shape as `GET /api/peertube/status` |
| `sync_started` | `{ channel_id, started_at }` |
| `sync_progress` | `{ channel_id, phase, current, total, … }` |
| `sync_complete` | `{ channel_id, stats }` |
| `sync_failed`   | `{ channel_id, error }` |
| `video_status`  | `{ id, status, progress, channel_id, … }` |

Consume with any SSE client. The CLI uses this stream for
`yt2pt channels sync`; the Web UI uses it for live updates.

Minimal `curl` example:

```bash
curl -N http://localhost:8090/api/events
```
