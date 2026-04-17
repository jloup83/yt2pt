# Running the daemon as a systemd service

After `sudo ./deploy/install.sh`, the `yt2ptd.service` unit is available.

## Enable and start at boot

```bash
sudo systemctl enable --now yt2ptd.service
```

## Start / stop / restart

```bash
sudo systemctl start    yt2ptd.service
sudo systemctl stop     yt2ptd.service
sudo systemctl restart  yt2ptd.service
sudo systemctl reload   yt2ptd.service   # (not supported — use restart)
```

## Status

```bash
systemctl status yt2ptd.service
```

Also check via the daemon itself:

```bash
yt2pt status
curl -fsS http://localhost:8090/api/health
```

## Logs

The daemon writes to two places:

1. **journald** (stdout/stderr captured by systemd):

   ```bash
   journalctl -u yt2ptd.service            # all logs
   journalctl -u yt2ptd.service -f         # follow
   journalctl -u yt2ptd.service --since "1 hour ago"
   journalctl -u yt2ptd.service -p err     # errors only
   ```

2. **File log** at `/var/log/yt2pt/yt2pt.log` (rotated to
   `yt2pt.log.1` on every daemon start):

   ```bash
   sudo tail -f /var/log/yt2pt/yt2pt.log
   ```

   Log level is controlled by `[yt2pt] log_level` in the config
   (`error` | `info` | `debug`).

## Disable and remove

```bash
sudo systemctl disable --now yt2ptd.service
```

Full removal: see [`installation.md#uninstall`](installation.md#uninstall).

## Unit file

The installed unit lives at `/etc/systemd/system/yt2ptd.service` and
runs the daemon as `yt2pt:yt2pt` with systemd hardening:

- `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=true`,
  `PrivateTmp=true`
- `ReadWritePaths=/var/lib/yt2pt /var/log/yt2pt /etc/yt2pt`
- `ProtectKernelTunables`, `ProtectKernelModules`, `ProtectControlGroups`
- `RestrictSUIDSGID`, `RestrictNamespaces`, `LockPersonality`
- `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK`
- `Restart=on-failure`, `RestartSec=5`

> `MemoryDenyWriteExecute` is **not** set: V8 (Node.js) requires
> read+write+execute pages for JIT and will crash on startup with
> `SIGTRAP` if that flag is enabled.

To customise the unit, use a drop-in:

```bash
sudo systemctl edit yt2ptd.service
```

## Reloading the config

After editing `/etc/yt2pt/yt2pt.conf.toml`:

```bash
sudo systemctl restart yt2ptd.service
```

The daemon reads the config once at startup.
