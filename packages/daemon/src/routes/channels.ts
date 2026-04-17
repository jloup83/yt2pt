import { execFile } from "node:child_process";
import { existsSync, statSync, createReadStream } from "node:fs";
import { join, resolve } from "node:path";
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
import { findYtDlpBinary, sanitize } from "../workers/paths";
import { deleteVideoById, PeertubeDeleteError } from "../videos/delete";

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
  avatar_url: string | null;
  banner_url: string | null;
}

/**
 * Slug used when looking up on-disk channel assets written by the
 * channel-info fetcher (#106). Mirrors `sanitize(meta.channel ?? meta.uploader ?? meta.title)`.
 * Falls back to null when no name was ever resolved, in which case no
 * avatar/banner is expected on disk.
 */
function channelAssetSlug(channel: Channel): string | null {
  const name = channel.youtube_channel_name;
  if (!name) return null;
  const slug = sanitize(name);
  return slug || null;
}

const IMAGE_EXTS = ["jpg", "jpeg", "png", "webp", "gif"] as const;
const CT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * Locate `<dataDir>/downloaded_from_youtube/<slug>/channel_info/<kind>.<ext>`
 * for the first extension that exists on disk. Returns null if not found
 * or if the channel has no resolved slug.
 */
export function findChannelAsset(
  dataDir: string,
  channel: Channel,
  kind: "avatar" | "banner",
): { path: string; ext: string } | null {
  const slug = channelAssetSlug(channel);
  if (!slug) return null;
  const dir = resolve(dataDir, "downloaded_from_youtube", slug, "channel_info");
  if (!existsSync(dir)) return null;
  for (const ext of IMAGE_EXTS) {
    const p = join(dir, `${kind}.${ext}`);
    if (existsSync(p)) return { path: p, ext };
  }
  return null;
}

export function summarizeChannel(
  db: import("better-sqlite3").Database,
  channel: Channel,
  dataDir: string,
): ChannelSummary {
  const rows = db
    .prepare("SELECT status, COUNT(*) AS n FROM videos WHERE channel_id = ? GROUP BY status")
    .all(channel.id) as { status: string; n: number }[];
  const status_summary: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    status_summary[r.status] = r.n;
    total += r.n;
  }
  const avatar = findChannelAsset(dataDir, channel, "avatar");
  const banner = findChannelAsset(dataDir, channel, "banner");
  return {
    ...channel,
    video_count: total,
    status_summary,
    avatar_url: avatar ? `/api/channels/${channel.id}/avatar` : null,
    banner_url: banner ? `/api/channels/${channel.id}/banner` : null,
  };
}

// ── Routes ──────────────────────────────────────────────────────────

export async function registerChannelRoutes(app: FastifyInstance): Promise<void> {
  const ctx: ServerContext = app.ctx;

  app.get("/api/channels", async () => {
    const rows = listChannels(ctx.db);
    return { channels: rows.map((c) => summarizeChannel(ctx.db, c, ctx.paths.dataDir)) };
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
    return summarizeChannel(ctx.db, row, ctx.paths.dataDir);
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
    const q = (req.query ?? {}) as { from_peertube?: string };
    const fromPeertube = q.from_peertube === "true" || q.from_peertube === "1";

    // Cascade through the video delete orchestrator so in-flight jobs
    // get cancelled, files are removed, and (optionally) PT rows are
    // deleted with the same semantics as per-video delete.
    const videoRows = ctx.db
      .prepare("SELECT id FROM videos WHERE channel_id = ?")
      .all(id) as { id: number }[];

    const warnings: string[] = [];
    for (const { id: vid } of videoRows) {
      try {
        const r = await deleteVideoById(
          { db: ctx.db, paths: ctx.paths, logger: ctx.logger, queue: ctx.queue, peertube: ctx.peertube },
          vid,
          { fromPeertube },
        );
        if (r) warnings.push(...r.warnings.map((w) => `video ${vid}: ${w}`));
      } catch (err) {
        if (err instanceof PeertubeDeleteError) {
          reply.code(502);
          return { error: err.message, status: err.status, failed_video_id: vid };
        }
        throw err;
      }
    }

    deleteChannel(ctx.db, id);
    reply.code(200);
    return {
      status: "deleted",
      id,
      videos_deleted: videoRows.length,
      warnings,
    };
  });

  app.get("/api/channels/:id/avatar", async (req, reply) => {
    return serveChannelAsset(req, reply, "avatar");
  });

  app.get("/api/channels/:id/banner", async (req, reply) => {
    return serveChannelAsset(req, reply, "banner");
  });

  async function serveChannelAsset(
    req: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply,
    kind: "avatar" | "banner",
  ): Promise<unknown> {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(400);
      return { error: "invalid id" };
    }
    const channel = getChannelById(ctx.db, id);
    if (!channel) {
      reply.code(404);
      return { error: "channel not found" };
    }
    const asset = findChannelAsset(ctx.paths.dataDir, channel, kind);
    if (!asset) {
      reply.code(404);
      return { error: `${kind} not available` };
    }
    const size = statSync(asset.path).size;
    reply.header("Content-Type", CT[asset.ext] ?? "application/octet-stream");
    reply.header("Content-Length", String(size));
    reply.header("Cache-Control", "public, max-age=300");
    return reply.send(createReadStream(asset.path));
  }

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
    if (!ctx.sync) {
      reply.code(503);
      return { error: "sync engine not available" };
    }
    const result = ctx.sync.trigger(id);
    if (result.status === "in_progress") {
      reply.code(409);
      return { error: "sync already in progress", channel_id: id };
    }
    if (result.status === "rate_limited") {
      reply.code(429);
      reply.header("Retry-After", String(result.retry_after_s));
      return { error: "rate limited", channel_id: id, retry_after_s: result.retry_after_s };
    }
    reply.code(202);
    return { status: "started", channel_id: id };
  });
}
