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
    const body = (req.body ?? {}) as { youtube_url?: unknown; overrides?: unknown };
    const rawUrl = typeof body.youtube_url === "string" ? body.youtube_url : "";
    const normalized = normalizeYoutubeChannelUrl(rawUrl);
    if (!normalized) {
      reply.code(400);
      return { error: "invalid YouTube channel URL" };
    }
    const overrides = sanitizeOverrides(body.overrides);

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
    };
    const rawUrl = typeof body.youtube_url === "string" ? body.youtube_url : "";
    const normalized = normalizeYoutubeChannelUrl(rawUrl);
    if (!normalized) {
      reply.code(400);
      return { error: "invalid YouTube channel URL" };
    }
    const overrides = sanitizeOverrides(body.overrides);

    // Refuse to create a duplicate yt2pt mapping. The user must remove
    // the existing one explicitly first.
    const existing = getChannelByUrl(ctx.db, normalized);
    if (existing) {
      reply.code(409);
      return {
        error: "this YouTube channel is already mapped",
        channel_id: existing.id,
        peertube_channel_id: existing.peertube_channel_id,
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
    });

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
