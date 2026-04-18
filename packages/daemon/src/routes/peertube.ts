import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../server";
import type { PeertubeConnection } from "../peertube/connection";
import { fetchChannelInfo as defaultFetchChannelInfo } from "../sync/channel-info";
import {
  createChannelFromYoutube as defaultCreateChannelFromYoutube,
  buildPeertubeChannelPayload,
  PeertubeApiError,
  type BuildPayloadOverrides,
} from "../peertube/create-channel";
import { findYtDlpBinary } from "../workers/paths";
import { normalizeYoutubeChannelUrl } from "./channels";
import { getChannelByUrl, insertChannel } from "../db/channels";

export interface PeertubeChannel {
  id: number;
  name: string;
  displayName: string;
}

interface RawChannel {
  id: number;
  name: string;
  displayName?: string;
  ownerAccount?: { id: number; name: string };
}

const CHANNEL_CACHE_TTL_MS = 5 * 60 * 1000;

interface ChannelCacheEntry {
  fetchedAt: number;
  channels: PeertubeChannel[];
}

/**
 * Fetch the authenticated user's video channels from the PeerTube API.
 * Uses /users/me which returns the current user and their video channels.
 * Sorted by displayName client-side to match the spec.
 */
export async function fetchUserChannels(peertube: PeertubeConnection): Promise<PeertubeChannel[]> {
  const res = await peertube.authFetch("/users/me");
  if (!res.ok) {
    throw new Error(`users/me returned ${res.status}`);
  }
  const body = (await res.json()) as { videoChannels?: RawChannel[] };
  const raw = Array.isArray(body.videoChannels) ? body.videoChannels : [];
  return raw
    .map((c) => ({
      id: c.id,
      name: c.name,
      displayName: c.displayName ?? c.name,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function registerPeertubeRoutes(app: FastifyInstance): Promise<void> {
  const ctx: ServerContext = app.ctx;
  let cache: ChannelCacheEntry | null = null;

  app.get("/api/peertube/status", async () => {
    if (!ctx.peertube) {
      return {
        online: false,
        authenticated: false,
        instance_url: ctx.config.peertube.instance_url,
        username: null,
      };
    }
    return ctx.peertube.getStatus();
  });

  app.get("/api/peertube/channels", async (req, reply) => {
    if (!ctx.peertube) {
      reply.code(503);
      return { error: "peertube connection not initialized" };
    }
    if (!ctx.peertube.isAuthenticated()) {
      reply.code(401);
      return { error: "not authenticated with peertube" };
    }

    const refresh = (req.query as { refresh?: string } | undefined)?.refresh === "1";
    const now = Date.now();
    if (!refresh && cache && now - cache.fetchedAt < CHANNEL_CACHE_TTL_MS) {
      return { channels: cache.channels, cached: true };
    }

    try {
      const channels = await fetchUserChannels(ctx.peertube);
      cache = { fetchedAt: now, channels };
      return { channels, cached: false };
    } catch (err) {
      ctx.logger.error(
        `Failed to fetch peertube channels: ${err instanceof Error ? err.message : String(err)}`
      );
      reply.code(502);
      return { error: "failed to fetch channels from peertube" };
    }
  });

  // ── POST /api/peertube/channels/preview-from-youtube ─────────────
  //
  // Dry-run: fetches YouTube channel info via yt-dlp and returns the
  // proposed PeerTube payload (slug, displayName, description, support)
  // without contacting PeerTube and without recording a mapping. Used
  // by the Web UI to show a confirmation preview.
  app.post("/api/peertube/channels/preview-from-youtube", async (req, reply) => {
    const body = (req.body ?? {}) as { youtube_url?: unknown; overrides?: unknown; language?: unknown };
    const rawUrl = typeof body.youtube_url === "string" ? body.youtube_url : "";
    const normalized = normalizeYoutubeChannelUrl(rawUrl);
    if (!normalized) {
      reply.code(400);
      return { error: "invalid YouTube channel URL" };
    }
    const overrides = sanitizeOverrides(body.overrides);
    const language = typeof body.language === "string" && (body.language === "en" || body.language === "fr")
      ? body.language
      : "fr";

    const fetchInfo = ctx.channelInfoFetcher ?? defaultFetchChannelInfo;
    let ytdlp = "";
    if (!ctx.channelInfoFetcher) {
      try {
        ytdlp = await findYtDlpBinary(ctx.paths.binDir);
      } catch (err) {
        ctx.logger.error(
          `yt-dlp binary unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
        reply.code(503);
        return { error: "yt-dlp unavailable" };
      }
    }

    let info;
    try {
      info = await fetchInfo({
        ytdlp,
        channelUrl: normalized,
        dataDir: ctx.paths.dataDir,
        logger: ctx.logger,
        language,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.error(`channel-info fetch failed: ${msg}`);
      reply.code(502);
      return { error: `failed to fetch YouTube channel info: ${msg}` };
    }

    let meta: Record<string, unknown>;
    try {
      const { readFile } = await import("node:fs/promises");
      meta = JSON.parse(await readFile(info.metadataPath, "utf-8")) as Record<string, unknown>;
    } catch (err) {
      reply.code(500);
      return { error: `failed to read channel metadata: ${err instanceof Error ? err.message : String(err)}` };
    }

    let payload;
    try {
      payload = buildPeertubeChannelPayload(meta, overrides);
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }

    const existing = getChannelByUrl(ctx.db, normalized);

    return {
      youtube_channel_url: normalized,
      payload,
      has_avatar: info.avatarPath !== null,
      has_banner: info.bannerPath !== null,
      already_mapped: existing !== null,
      existing_peertube_channel_id: existing?.peertube_channel_id ?? null,
    };
  });

  // ── POST /api/peertube/channels/create-from-youtube ──────────────
  app.post("/api/peertube/channels/create-from-youtube", async (req, reply) => {
    if (!ctx.peertube) {
      reply.code(503);
      return { error: "peertube connection not initialized" };
    }
    if (!ctx.peertube.isAuthenticated()) {
      reply.code(401);
      return { error: "not authenticated with peertube" };
    }

    const body = (req.body ?? {}) as {
      youtube_url?: unknown;
      overrides?: unknown;
      language?: unknown;
    };
    const rawUrl = typeof body.youtube_url === "string" ? body.youtube_url : "";
    const normalized = normalizeYoutubeChannelUrl(rawUrl);
    if (!normalized) {
      reply.code(400);
      return { error: "invalid YouTube channel URL" };
    }
    const overrides = sanitizeOverrides(body.overrides);
    const language = typeof body.language === "string" && (body.language === "en" || body.language === "fr")
      ? body.language
      : "fr";

    // If a mapping already exists, the PT channel was created previously.
    // Skip creation and just kick off a sync so missing videos start
    // flowing — this makes the endpoint idempotent from the user's POV.
    const existing = getChannelByUrl(ctx.db, normalized);
    if (existing) {
      ctx.logger.info(
        `create-from-youtube: channel already mapped — skipping PT channel creation ` +
          `(youtube_url=${normalized}, mapping_id=${existing.id}, ` +
          `peertube_channel_id=${existing.peertube_channel_id})`,
      );
      const syncResult = triggerSyncSafely(ctx, existing.id);
      reply.code(200);
      return {
        already_mapped: true,
        mapping: {
          id: existing.id,
          youtube_channel_url: existing.youtube_channel_url,
          peertube_channel_id: existing.peertube_channel_id,
        },
        sync: syncResult,
      };
    }

    const fetchInfo = ctx.channelInfoFetcher ?? defaultFetchChannelInfo;
    const createFn = ctx.ptChannelCreator ?? defaultCreateChannelFromYoutube;

    // Only resolve the yt-dlp binary when using the real fetcher; the
    // test seam supplies metadata directly and doesn't spawn yt-dlp.
    let ytdlp = "";
    if (!ctx.channelInfoFetcher) {
      try {
        ytdlp = await findYtDlpBinary(ctx.paths.binDir);
      } catch (err) {
        ctx.logger.error(
          `yt-dlp binary unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
        reply.code(503);
        return { error: "yt-dlp unavailable" };
      }
    }

    let info;
    try {
      info = await fetchInfo({
        ytdlp,
        channelUrl: normalized,
        dataDir: ctx.paths.dataDir,
        logger: ctx.logger,
        language,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.error(`channel-info fetch failed: ${msg}`);
      reply.code(502);
      return { error: `failed to fetch YouTube channel info: ${msg}` };
    }

    let result;
    try {
      result = await createFn({
        pt: ctx.peertube,
        logger: ctx.logger,
        dataDir: ctx.paths.dataDir,
        channelInfo: info,
        overrides,
      });
    } catch (err) {
      if (err instanceof PeertubeApiError) {
        reply.code(err.status === 409 ? 409 : 502);
        return {
          error: err.message,
          peertube_status: err.status,
          peertube_body: err.body,
          // Re-surface the slug we tried so the UI can pre-fill the
          // override input on retry.
          attempted_slug: overrides.name ?? null,
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.error(`PT channel creation failed: ${msg}`);
      reply.code(500);
      return { error: msg };
    }

    // Persist the yt2pt mapping (empty channel — no videos yet).
    const mapping = insertChannel(ctx.db, {
      youtube_channel_url: normalized,
      youtube_channel_name:
        (typeof overrides.displayName === "string" && overrides.displayName) || null,
      peertube_channel_id: String(result.created.id),
      language,
    });

    ctx.logger.info(
      `create-from-youtube: created PeerTube channel and mapping ` +
        `(youtube_url=${normalized}, mapping_id=${mapping.id}, ` +
        `peertube_channel_id=${result.created.id}, name=${result.created.name}, ` +
        `displayName=${result.payload.displayName})`,
    );

    // Kick off the initial sync so the user doesn't have to click again.
    const syncResult = triggerSyncSafely(ctx, mapping.id);

    // Invalidate the PT channels cache so the UI dropdown refreshes.
    cache = null;

    reply.code(201);
    return {
      mapping: {
        id: mapping.id,
        youtube_channel_url: mapping.youtube_channel_url,
        peertube_channel_id: mapping.peertube_channel_id,
      },
      peertube_channel: result.created,
      payload: result.payload,
      warnings: result.warnings,
      sync: syncResult,
    };
  });
}

function sanitizeOverrides(raw: unknown): BuildPayloadOverrides {
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  const out: BuildPayloadOverrides = {};
  for (const k of ["name", "displayName", "description", "support"] as const) {
    const v = o[k];
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Trigger a sync without throwing. Returns a small status object suitable
 * for inclusion in API responses. Used by create-from-youtube to start
 * pulling videos right after a mapping is created (or already exists).
 */
function triggerSyncSafely(
  ctx: ServerContext,
  channelId: number,
): { status: "started" | "in_progress" | "rate_limited" | "unavailable" | "error"; retry_after_s?: number; error?: string } {
  if (!ctx.sync) {
    ctx.logger.warn(
      `create-from-youtube: sync engine unavailable, skipping auto-sync (channel_id=${channelId})`,
    );
    return { status: "unavailable" };
  }
  try {
    const r = ctx.sync.trigger(channelId);
    if (r.status === "in_progress") {
      ctx.logger.info(`create-from-youtube: sync already in progress (channel_id=${channelId})`);
      return { status: "in_progress" };
    }
    if (r.status === "rate_limited") {
      ctx.logger.info(
        `create-from-youtube: sync rate-limited (channel_id=${channelId}, retry_after_s=${r.retry_after_s})`,
      );
      return { status: "rate_limited", retry_after_s: r.retry_after_s };
    }
    ctx.logger.info(`create-from-youtube: sync started (channel_id=${channelId})`);
    return { status: "started" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logger.error(`create-from-youtube: sync trigger failed (channel_id=${channelId}): ${msg}`);
    return { status: "error", error: msg };
  }
}
