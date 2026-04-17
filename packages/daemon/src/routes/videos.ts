import type { FastifyInstance } from "fastify";
import type { Database } from "better-sqlite3";
import type { ServerContext } from "../server";
import { VIDEO_STATUS, type VideoStatus } from "../db/schema";
import {
  getChannelByUrl,
  insertChannel,
  type Channel,
} from "../db/channels";
import {
  getVideoByYoutubeId,
  insertVideo,
} from "../db/videos";
import { findYtDlpBinary } from "../workers/paths";
import { normalizeYoutubeChannelUrl } from "./channels";
import {
  extractYoutubeVideoId,
  makeDefaultVideoResolver,
  normalizeYoutubeVideoUrl,
  type VideoResolver,
} from "./youtube-video";
import { deleteVideoById, PeertubeDeleteError } from "../videos/delete";

export interface VideoWithChannel {
  id: number;
  youtube_video_id: string;
  channel_id: number;
  channel_name: string | null;
  title: string | null;
  status: VideoStatus;
  progress_pct: number;
  error_message: string | null;
  folder_name: string | null;
  upload_date: string | null;
  created_at: string;
  updated_at: string;
}

const SORT_COLUMNS = new Set(["updated_at", "created_at", "title", "upload_date"]);
const VALID_STATUSES: Set<string> = new Set(VIDEO_STATUS);

export interface ListVideosParams {
  channelId?: number;
  statuses?: VideoStatus[];
  page: number;
  perPage: number;
  sort: "updated_at" | "created_at" | "title" | "upload_date";
  order: "asc" | "desc";
}

export interface ListVideosResult {
  videos: VideoWithChannel[];
  total: number;
  page: number;
  per_page: number;
}

const SELECT_WITH_CHANNEL = `
  SELECT v.id, v.youtube_video_id, v.channel_id,
         c.youtube_channel_name AS channel_name,
         v.title, v.status, v.progress_pct, v.error_message,
         v.folder_name, v.upload_date, v.created_at, v.updated_at
  FROM videos v
  LEFT JOIN channels c ON c.id = v.channel_id
`;

export function listVideosWithChannel(db: Database, params: ListVideosParams): ListVideosResult {
  const wheres: string[] = [];
  const args: unknown[] = [];
  if (params.channelId !== undefined) {
    wheres.push("v.channel_id = ?");
    args.push(params.channelId);
  }
  if (params.statuses && params.statuses.length > 0) {
    wheres.push(`v.status IN (${params.statuses.map(() => "?").join(",")})`);
    args.push(...params.statuses);
  }
  const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";

  const total = (db
    .prepare(`SELECT COUNT(*) AS n FROM videos v ${whereSql}`)
    .get(...args) as { n: number }).n;

  const offset = (params.page - 1) * params.perPage;
  const rows = db
    .prepare(
      `${SELECT_WITH_CHANNEL}
       ${whereSql}
       ORDER BY v.${params.sort} ${params.order === "asc" ? "ASC" : "DESC"}, v.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...args, params.perPage, offset) as VideoWithChannel[];

  return { videos: rows, total, page: params.page, per_page: params.perPage };
}

export function getVideoWithChannel(db: Database, id: number): VideoWithChannel | null {
  return (
    (db
      .prepare(`${SELECT_WITH_CHANNEL} WHERE v.id = ?`)
      .get(id) as VideoWithChannel | undefined) ?? null
  );
}

/** Parse a ?status=A,B,C string into a validated status list. Returns null if any token is unknown. */
export function parseStatuses(raw: string | undefined): VideoStatus[] | null | undefined {
  if (raw === undefined || raw === "") return undefined;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  for (const s of parts) if (!VALID_STATUSES.has(s)) return null;
  return parts as VideoStatus[];
}

export async function registerVideoRoutes(app: FastifyInstance): Promise<void> {
  const ctx: ServerContext = app.ctx;

  app.get("/api/videos", async (req, reply) => {
    const q = (req.query ?? {}) as {
      channel?: string;
      status?: string;
      page?: string;
      per_page?: string;
      sort?: string;
      order?: string;
    };

    let channelId: number | undefined;
    if (q.channel !== undefined && q.channel !== "") {
      const n = Number(q.channel);
      if (!Number.isInteger(n) || n <= 0) {
        reply.code(400);
        return { error: "invalid channel id" };
      }
      channelId = n;
    }

    const statuses = parseStatuses(q.status);
    if (statuses === null) {
      reply.code(400);
      return { error: "invalid status filter" };
    }

    const page = q.page ? Math.max(1, Number(q.page) | 0) : 1;
    const perPageRaw = q.per_page ? Number(q.per_page) | 0 : 50;
    const perPage = Math.max(1, Math.min(200, perPageRaw));

    const sort = SORT_COLUMNS.has(q.sort ?? "") ? (q.sort as "updated_at" | "created_at" | "title" | "upload_date") : "updated_at";
    const order = q.order === "asc" ? "asc" : "desc";

    return listVideosWithChannel(ctx.db, {
      channelId,
      statuses: statuses ?? undefined,
      page,
      perPage,
      sort,
      order,
    });
  });

  app.get("/api/videos/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(400);
      return { error: "invalid id" };
    }
    const row = getVideoWithChannel(ctx.db, id);
    if (!row) {
      reply.code(404);
      return { error: "not found" };
    }
    return row;
  });

  // ── DELETE /api/videos/:id — delete one video ─────────────────────
  //
  // Cancels any in-flight job, removes local files (both downloaded and
  // converted-for-PT copies), optionally deletes the video from PeerTube
  // (query `from_peertube=true|false`, default false), and finally drops
  // the DB row. Returns 204 with the orchestrator result in the body for
  // clients that care about warnings.
  app.delete("/api/videos/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(400);
      return { error: "invalid id" };
    }
    const q = (req.query ?? {}) as { from_peertube?: string };
    const fromPeertube = q.from_peertube === "true" || q.from_peertube === "1";

    try {
      const result = await deleteVideoById(
        { db: ctx.db, paths: ctx.paths, logger: ctx.logger, queue: ctx.queue, peertube: ctx.peertube },
        id,
        { fromPeertube },
      );
      if (!result) {
        reply.code(404);
        return { error: "not found" };
      }
      reply.code(200);
      return { status: "deleted", ...result };
    } catch (err) {
      if (err instanceof PeertubeDeleteError) {
        reply.code(502);
        return { error: err.message, status: err.status };
      }
      throw err;
    }
  });

  // ── POST /api/videos — single-video sync ─────────────────────────
  //
  // Body: { youtube_url: string, peertube_channel_id: string|number }
  //
  // Resolves the video's YouTube channel via yt-dlp, either reuses an
  // existing yt2pt channel mapping or creates one on the fly, and
  // enqueues the video for the download → convert → upload pipeline.
  app.post("/api/videos", async (req, reply) => {
    const body = (req.body ?? {}) as {
      youtube_url?: unknown;
      peertube_channel_id?: unknown;
    };

    const rawUrl = typeof body.youtube_url === "string" ? body.youtube_url : "";
    const ptId =
      typeof body.peertube_channel_id === "string"
        ? body.peertube_channel_id
        : typeof body.peertube_channel_id === "number"
          ? String(body.peertube_channel_id)
          : "";

    if (!rawUrl || !ptId) {
      reply.code(400);
      return { error: "youtube_url and peertube_channel_id are required" };
    }

    const videoId = extractYoutubeVideoId(rawUrl);
    const normalizedUrl = normalizeYoutubeVideoUrl(rawUrl);
    if (!videoId || !normalizedUrl) {
      reply.code(400);
      return { error: "invalid YouTube video URL" };
    }

    // Short-circuit before ever launching yt-dlp: the video may already
    // be tracked under a channel we know.
    const already = getVideoByYoutubeId(ctx.db, videoId);
    if (already) {
      reply.code(409);
      return {
        error: "video already tracked",
        video_id: already.id,
        channel_id: already.channel_id,
        status: already.status,
      };
    }

    // Resolve channel info via yt-dlp (or an injected resolver in tests).
    let resolver: VideoResolver;
    if (ctx.videoResolver) {
      resolver = ctx.videoResolver;
    } else {
      try {
        const ytdlp = await findYtDlpBinary(ctx.paths.binDir);
        resolver = makeDefaultVideoResolver(ytdlp, ctx.logger);
      } catch (err) {
        ctx.logger.error(
          `yt-dlp binary unavailable: ${err instanceof Error ? err.message : String(err)}`
        );
        reply.code(503);
        return { error: "yt-dlp unavailable" };
      }
    }

    let meta;
    try {
      meta = await resolver(normalizedUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.error(`video metadata fetch failed for ${normalizedUrl}: ${msg}`);
      reply.code(502);
      return { error: `failed to fetch video metadata: ${msg}` };
    }

    if (meta.youtube_video_id !== videoId) {
      ctx.logger.info(
        `video id mismatch: URL said ${videoId}, yt-dlp said ${meta.youtube_video_id}. Using yt-dlp.`
      );
    }

    if (!meta.channel_url) {
      reply.code(502);
      return { error: "could not determine the video's YouTube channel" };
    }
    const canonicalChannelUrl = normalizeYoutubeChannelUrl(meta.channel_url) ?? meta.channel_url;

    // Find-or-create the yt2pt channel mapping. If an existing mapping
    // targets a *different* PeerTube channel, surface a 409 instead of
    // silently uploading to the wrong place.
    let channel: Channel | null = getChannelByUrl(ctx.db, canonicalChannelUrl);
    if (channel) {
      if (channel.peertube_channel_id !== ptId) {
        reply.code(409);
        return {
          error:
            "this YouTube channel is already mapped to a different PeerTube channel",
          channel_id: channel.id,
          existing_peertube_channel_id: channel.peertube_channel_id,
          requested_peertube_channel_id: ptId,
        };
      }
    } else {
      channel = insertChannel(ctx.db, {
        youtube_channel_url: canonicalChannelUrl,
        youtube_channel_name: meta.channel_name,
        peertube_channel_id: ptId,
      });
    }

    // Double-check the video wasn't inserted by a concurrent request.
    const race = getVideoByYoutubeId(ctx.db, meta.youtube_video_id);
    if (race) {
      reply.code(409);
      return {
        error: "video already tracked",
        video_id: race.id,
        channel_id: race.channel_id,
        status: race.status,
      };
    }

    const video = insertVideo(ctx.db, {
      youtube_video_id: meta.youtube_video_id,
      channel_id: channel.id,
      title: meta.title,
      status: "DOWNLOAD_QUEUED",
    });

    ctx.queue?.notifyNewJob();

    reply.code(202);
    return {
      status: "queued",
      video_id: video.id,
      channel_id: channel.id,
    };
  });
}
