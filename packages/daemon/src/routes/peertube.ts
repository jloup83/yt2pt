import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../server";
import type { PeertubeConnection } from "../peertube/connection";

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
}
