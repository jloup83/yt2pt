# Troubleshooting

## The service fails to start

Always check logs first:

```bash
systemctl status yt2ptd.service
journalctl -u yt2ptd.service -n 100 --no-pager
sudo tail -f /var/log/yt2pt/yt2pt.log
```

---

### `/usr/bin/env: 'node': No such file or directory` (exit 127)

Cause: `node` is only installed under your user (nvm). The daemon runs
as the `yt2pt` system user with `ProtectHome=true` and cannot see
`$HOME`.

Fix: install Node.js system-wide and re-run the installer.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
which node          # should be /usr/bin/node
sudo ./deploy/install.sh
sudo systemctl restart yt2ptd.service
```

---

### `code=dumped, signal=TRAP` (V8 SIGTRAP on startup)

Cause: `MemoryDenyWriteExecute=yes` in the unit file — V8's JIT requires
RWX pages.

The shipped unit (as of v1.0.0) does **not** set that flag. If you have
a local drop-in that does, remove it:

```bash
sudo systemctl edit yt2ptd.service      # remove MemoryDenyWriteExecute
sudo systemctl restart yt2ptd.service
```

---

### `ENOENT … mkdir '/nonexistent/.local/share/yt2pt'`

Cause: path mode detected as `user` instead of `root`. This happens when
`/etc/yt2pt/yt2pt.toml` is missing.

Fix: make sure the installer ran cleanly, or recreate the config:

```bash
sudo install -d -m 0750 -o root -g yt2pt /etc/yt2pt
sudo install -m 0640 -o root -g yt2pt yt2pt.production.toml /etc/yt2pt/yt2pt.toml
sudo systemctl restart yt2ptd.service
```

---

### `uv_interface_addresses returned Unknown system error 97`

Cause: `RestrictAddressFamilies` in the unit file doesn't include
`AF_NETLINK` (needed by `os.networkInterfaces()`).

Fix: make sure your unit has:

```ini
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
```

Then `sudo systemctl daemon-reload && sudo systemctl restart yt2ptd`.

---

## `yt2pt status` says "Could not reach yt2ptd"

The CLI connects to `http://localhost:8090` by default. Check:

```bash
systemctl is-active yt2ptd.service
ss -ltn | grep 8090
curl -fsS http://localhost:8090/api/health
```

If the daemon binds only to `127.0.0.1` but you're running the CLI from
another host, either tunnel the port over SSH or point the CLI at the
right host:

```bash
yt2pt --daemon-url=http://server:8090 status
# or:
export YT2PT_DAEMON_URL=http://server:8090
```

---

## PeerTube status shows `offline` or `not authenticated`

- **Offline** — the daemon can't reach `[peertube].instance_url`.
  Test manually: `curl -fsS $instance_url/api/v1/config | head`.

- **Not authenticated** — the token is missing or expired. Refresh it:

  ```bash
  yt2pt token <username> <password>
  ```

  Tokens are valid for a few hours; you can run this at any time.

---

## Sync keeps returning "rate limited"

The sync engine enforces a per-channel cooldown to avoid hammering
YouTube and PeerTube. The error response includes a `retry_after_s`
field. Wait it out, or trigger a different channel in the meantime.

---

## yt-dlp errors

- **`ffmpeg not found`** — install ffmpeg (see [installation.md](installation.md)).
- **`HTTP Error 403`** — YouTube may be throttling. yt-dlp's extractor
  lags behind YouTube changes occasionally; wait for the next bundled
  yt-dlp update (we ship a pinned binary under `bin/`).
- **Video is members-only / age-gated** — yt-dlp cannot fetch it without
  cookies. Not currently supported by yt2pt.

---

## Database locked / corrupted

The DB is a single file at `<data_dir>/yt2pt.db` with a WAL. Stop the
daemon first; don't kill it mid-write.

```bash
sudo systemctl stop yt2ptd.service
ls -l /var/lib/yt2pt/yt2pt.db*
# If truly corrupted, back up and remove — the daemon recreates schema
# on start. You will lose tracked video history; channel mappings too.
sudo mv /var/lib/yt2pt/yt2pt.db{,.bak}
sudo systemctl start yt2ptd.service
```

---

## "Config file location does not exist" during upgrade

The installer never overwrites `/etc/yt2pt/yt2pt.toml`. If you
accidentally `--purge`d it, reinstall to get a fresh example:

```bash
sudo ./deploy/install.sh
sudoedit /etc/yt2pt/yt2pt.toml
```

---

## Getting more verbose logs

Raise the log level:

```bash
sudo sed -i 's/^log_level = .*/log_level = "debug"/' /etc/yt2pt/yt2pt.toml
sudo systemctl restart yt2ptd.service
journalctl -u yt2ptd.service -f
```

Don't forget to set it back to `info` when done.

---

## Still stuck?

Open an issue with:

- `yt2pt status --json`
- `systemctl status yt2ptd.service --no-pager`
- Last ~50 lines of `journalctl -u yt2ptd.service`
- Last ~50 lines of `/var/log/yt2pt/yt2pt.log`
- Your `yt2pt.toml` with the `api_token` redacted
