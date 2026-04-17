import { execFile } from "node:child_process";
import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../server";
import {
  deleteChannel,
  getChannelById,
  getChannelByUrl,
  insertChannel,
  listChannels,
  type Channel,
} from "../db/channels";
import { findYtDlpBinary } from "../workers/paths";

// ── YouTube URL validation ──────────────────────────────────────────

const YT_HOSTS = new Set([
  "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
  "youtu.be",
]);

/**
 * Normalize a YouTube channel URL to a canonical form. Accepts
 * `@handle`, `/channel/UC...`, `/c/name`, `/user/name`. Returns null if
 * the URL does not look like a YouTube channel URL.
 */
export function normalizeYoutubeChannelUrl(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (!YT_HOSTS.has(url.hostname.toLowerCase())) return null;

  const path = url.pathname.replace(/\/+$/, "");
  // /@handle
  if (/^\/@[A-Za-z0-9._-]+$/.test(path)) {
    return `https://www.youtube.com${path}`;
  }
  const m = /^\/(channel|c|user)\/([A-Za-z0-9._-]+)$/.exec(path);
  if (m) {
    return `https://www.youtube.com/${m[1]}/${m[2]}`;
  }
  return null;
}

// ── yt-dlp channel name resolution ──────────────────────────────────

function execFileP(cmd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

/**
 * Ask yt-dlp for the channel display name. Uses `--flat-playlist` and
 * `--playlist-items 0` so nothing is actually downloaded, only the
 * top-level channel metadata.
 */
export async function resolveYoutubeChannelName(ytdlp: string, url: string): Promise<string | null> {
  try {
    const stdout = await execFileP(ytdlp, [
      "--dump-single-json",
      "--flat-playlist",
      "--playlist-items", "0",
      url,
    ]);
    const meta = JSON.parse(stdout) as { channel?: string; title?: string; uploader?: string };
    return meta.channel ?? meta.uploader ?? meta.title ?? null;
  } catch {
    return null;
  }
}

// ── Status summary ──────────────────────────────────────────────────

export interface ChannelSummary extends Channel {
  video_count: number;
  status_summary: Record<string, number>;
}

export function summarizeChannel(db: import("better-sqlite3").Database, channel: Channel): ChannelSummary {
  const rows = db
    .prepare("SELECT status, COUNT(*) AS n FROM videos WHERE channel_id = ? GROUP BY status")
    .all(channel.id) as { status: string; n: number }[];
  const status_summary: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    status_summary[r.status] = r.n;
    total += r.n;
  }
  return { ...channel, video_count: total, status_summary };
}

// ── Routes ──────────────────────────────────────────────────────────

export async function registerChannelRoutes(app: FastifyInstance): Promise<void> {
  const ctx: ServerContext = app.ctx;

  app.get("/api/channels", async () => {
    const rows = listChannels(ctx.db);
    return { channels: rows.map((c) => summarizeChannel(ctx.db, c)) };
  });

  app.post("/api/channels", async (req, reply) => {
    const body = req.body as { youtube_channel_url?: unknown; peertube_channel_id?: unknown } | undefined;
    const rawUrl = typeof body?.youtube_channel_url === "string" ? body.youtube_channel_url : "";
    const peertubeId = typeof body?.peertube_channel_id === "string"
      ? body.peertube_channel_id
      : typeof body?.peertube_channel_id === "number"
        ? String(body.peertube_channel_id)
        : "";

    if (!rawUrl || !peertubeId) {
      reply.code(400);
      return { error: "youtube_channel_url and peertube_channel_id are required" };
    }

    const normalized = normalizeYoutubeChannelUrl(rawUrl);
    if (!normalized) {
      reply.code(400);
      return { error: "invalid YouTube channel URL" };
    }

    if (getChannelByUrl(ctx.db, normalized)) {
      reply.code(409);
      return { error: "channel already mapped" };
    }

    // Best-effort name resolution via yt-dlp; not a hard failure if yt-dlp
    // isn't installed or the channel is unavailable — the row still goes in.
    let channelName: string | null = null;
    try {
      const ytdlp = await findYtDlpBinary(ctx.paths.binDir);
      channelName = await resolveYoutubeChannelName(ytdlp, normalized);
    } catch (err) {
      ctx.logger.debug(`yt-dlp channel name resolution skipped: ${err instanceof Error ? err.message : String(err)}`);
    }

    const row = insertChannel(ctx.db, {
      youtube_channel_url: normalized,
      youtube_channel_name: channelName,
      peertube_channel_id: peertubeId,
    });
    reply.code(201);
    return summarizeChannel(ctx.db, row);
  });

  app.delete("/api/channels/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(400);
      return { error: "invalid id" };
    }
    const row = getChannelById(ctx.db, id);
    if (!row) {
      reply.code(404);
      return { error: "not found" };
    }
    deleteChannel(ctx.db, id);
    reply.code(204);
    return null;
  });

  app.post("/api/channels/:id/sync", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(400);
      return { error: "invalid id" };
    }
    const row = getChannelById(ctx.db, id);
    if (!row) {
      reply.code(404);
      return { error: "not found" };
    }
    // Sync engine lands in #62. Shape the response now so the UI and
    // tests can depend on it.
    reply.code(501);
    return { error: "sync engine not yet implemented", channel_id: id };
  });
}
