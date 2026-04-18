# Web UI guide

The Web UI is a Vue 3 single-page app bundled with the daemon. It is
served from the daemon's HTTP port (default `8090`) and talks to the
same REST + SSE endpoints the CLI uses.

Open it at:

```
http://<your-host>:8090/
```

If the daemon binds to `127.0.0.1`, access it from the same host or set
up an SSH tunnel / reverse proxy.

## Pages

### Home

- **Daemon status** — version, uptime, listening address.
- **PeerTube status** — online / offline, authenticated user, instance URL.
- **Channels** — list of YouTube → PeerTube mappings with a *Sync*
  button each. Sync progress is streamed live via SSE and rendered
  inline (phase, counts, per-video progress).
- **Add channel** — form: YouTube channel URL + PeerTube channel id.

### Activities

- Paginated list of all tracked videos with status, channel, and
  timestamps.
- Filter by status (e.g. show only `FAILED`) and by channel.
- Row-level updates arrive via SSE (`video_status` events) so the table
  stays fresh without a refresh.

### Settings

- Read-write view of the full config (sensitive fields redacted).
- Edit and save → the daemon writes back to `yt2pt.toml`.
- **PeerTube token** — embedded login form that calls
  `POST /api/settings/token`; the new token replaces `api_token`
  atomically without restarting the daemon.

## Server-Sent Events

The UI subscribes to `GET /api/events` (see [api.md](api.md)) and reacts
to:

- `hello` — handshake
- `peertube_status` — connection state changes
- `sync_started`, `sync_progress`, `sync_complete`, `sync_failed`
- `video_status` — individual video state transitions

## Reverse proxy

If you terminate TLS in front of the daemon, forward:

- `http://…/` → `http://127.0.0.1:8090/`
- Keep the `Cache-Control` and `X-Accel-Buffering` headers set by
  `/api/events` intact (don't buffer; SSE is chunked and long-lived).

Minimal nginx snippet:

```nginx
location / {
  proxy_pass http://127.0.0.1:8090;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  # SSE:
  proxy_buffering off;
  proxy_read_timeout 1h;
}
```
