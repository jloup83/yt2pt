#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ApiClient, ApiError, DaemonUnreachableError, resolveDaemonUrl } from "./api/client";
import { parseArgs } from "./argv";
import { runStatus } from "./commands/status";
import { runConfigGet, runConfigSet } from "./commands/config";
import { runToken } from "./commands/token";
import {
  runChannelsAdd,
  runChannelsList,
  runChannelsRemove,
  runChannelsSync,
} from "./commands/channels";
import { runVideosAdd, runVideosList } from "./commands/videos";
import { setJsonMode, paint } from "./output/format";

const { version: VERSION } = JSON.parse(
  readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"),
) as { version: string };

const HELP = `yt2pt v${VERSION} — CLI client for the yt2ptd daemon

Usage:
  yt2pt status                          Show daemon + PeerTube connection status
  yt2pt config                          Show current configuration
  yt2pt config <section.key> <value>    Set a configuration value
  yt2pt token <username> <password>     Acquire a PeerTube API token
  yt2pt channels list                   List configured channel mappings
  yt2pt channels add <yt-url> <pt-id>   Add a YouTube → PeerTube mapping
  yt2pt channels remove <id>            Remove a channel mapping
  yt2pt channels sync <id>              Trigger sync for a channel (live progress)
  yt2pt videos                          List tracked videos
  yt2pt videos --status=UPLOADING       Filter by status
  yt2pt videos --channel=<id>           Filter by channel
  yt2pt videos add <yt-url> <pt-id>     Queue a single video for sync
  yt2pt help                            Show this help
  yt2pt version                         Show version

Global flags:
  --daemon-url=<url>                    Override daemon URL (default: http://localhost:8090)
  --json                                Emit machine-readable JSON output
  --no-watch                            (channels sync) Don't stream live progress
  -h, --help                            Show this help
  -v, --version                         Show version

Environment:
  YT2PT_DAEMON_URL                      Default daemon URL
  NO_COLOR / YT2PT_NO_COLOR             Disable colored output
`;

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    return 1;
  }
  const { positional, flags } = parsed;

  if (flags.help === true || positional[0] === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (flags.version === true || positional[0] === "version") {
    process.stdout.write(`yt2pt v${VERSION}\n`);
    return 0;
  }
  if (positional.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }

  if (flags.json === true) setJsonMode(true);

  const daemonUrl = resolveDaemonUrl(
    typeof flags["daemon-url"] === "string" ? (flags["daemon-url"] as string) : undefined,
  );
  const client = new ApiClient({ baseUrl: daemonUrl });

  const [cmd, ...rest] = positional;

  try {
    return await dispatch(cmd, rest, flags, client);
  } catch (err) {
    return handleError(err, daemonUrl);
  }
}

async function dispatch(
  cmd: string,
  rest: string[],
  flags: Record<string, string | boolean>,
  client: ApiClient,
): Promise<number> {
  switch (cmd) {
    case "status":
      return runStatus(client);

    case "config":
      if (rest.length === 0) return runConfigGet(client);
      if (rest.length === 2) return runConfigSet(client, rest[0], rest[1]);
      process.stderr.write(`Error: 'config' takes either 0 or 2 arguments\n`);
      return 1;

    case "token":
      if (rest.length !== 2) {
        process.stderr.write(`Error: 'token' requires <username> and <password>\n`);
        return 1;
      }
      return runToken(client, rest[0], rest[1]);

    case "channels": {
      const [sub, ...subArgs] = rest;
      if (!sub) {
        process.stderr.write(`Error: 'channels' requires a subcommand (list|add|remove|sync)\n`);
        return 1;
      }
      switch (sub) {
        case "list":
          return runChannelsList(client);
        case "add":
          if (subArgs.length !== 2) {
            process.stderr.write(`Error: 'channels add' requires <yt-url> and <pt-id>\n`);
            return 1;
          }
          return runChannelsAdd(client, subArgs[0], subArgs[1]);
        case "remove":
        case "rm":
          if (subArgs.length !== 1) {
            process.stderr.write(`Error: 'channels remove' requires <id>\n`);
            return 1;
          }
          return runChannelsRemove(client, subArgs[0]);
        case "sync":
          if (subArgs.length !== 1) {
            process.stderr.write(`Error: 'channels sync' requires <id>\n`);
            return 1;
          }
          return runChannelsSync(client, subArgs[0], {
            watch: flags["no-watch"] !== true,
          });
        default:
          process.stderr.write(`Error: unknown 'channels' subcommand '${sub}'\n`);
          return 1;
      }
    }

    case "videos":
      if (rest.length > 0 && rest[0] === "add") {
        const subArgs = rest.slice(1);
        if (subArgs.length !== 2) {
          process.stderr.write(`Error: 'videos add' requires <yt-url> and <pt-id>\n`);
          return 1;
        }
        return runVideosAdd(client, subArgs[0], subArgs[1]);
      }
      return runVideosList(client, {
        status: typeof flags.status === "string" ? (flags.status as string) : undefined,
        channel: typeof flags.channel === "string" ? (flags.channel as string) : undefined,
        page: typeof flags.page === "string" ? Number(flags.page) : undefined,
        perPage: typeof flags["per-page"] === "string" ? Number(flags["per-page"]) : undefined,
      });

    default:
      process.stderr.write(`Error: unknown command '${cmd}'\n\n`);
      process.stdout.write(HELP);
      return 1;
  }
}

function handleError(err: unknown, daemonUrl: string): number {
  if (err instanceof DaemonUnreachableError) {
    process.stderr.write(
      `${paint("✗", "red")} Could not reach yt2ptd at ${daemonUrl}\n` +
      `  Is the daemon running? Start it with 'yt2ptd' (or 'systemctl start yt2pt').\n`,
    );
    return 2;
  }
  if (err instanceof ApiError) {
    process.stderr.write(`${paint("✗", "red")} ${err.message}\n`);
    return 1;
  }
  process.stderr.write(`${paint("✗", "red")} ${(err as Error).message ?? String(err)}\n`);
  return 1;
}

void main().then((code) => { process.exit(code); });
