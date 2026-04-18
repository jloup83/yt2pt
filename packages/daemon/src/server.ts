import Fastify, { type FastifyInstance } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { Database } from "better-sqlite3";
import type { Config, Logger, ResolvedPaths } from "@yt2pt/shared";
import type { PeertubeConnection } from "./peertube/connection";
import type { JobQueue } from "./queue";
import type { SyncEngine } from "./sync";
import type { VideoResolver } from "./routes/youtube-video";
import type { fetchChannelInfo } from "./sync/channel-info";
import type { createChannelFromYoutube } from "./peertube/create-channel";
import { registerSettingsRoutes } from "./routes/settings";
import { registerPeertubeRoutes } from "./routes/peertube";
import { registerChannelRoutes } from "./routes/channels";
import { registerVideoRoutes } from "./routes/videos";
import { registerEventsRoutes } from "./routes/events";

export interface ServerContext {
  config: Config;
  paths: ResolvedPaths;
  db: Database;
  logger: Logger;
  peertube?: PeertubeConnection;
  queue?: JobQueue;
  sync?: SyncEngine;
  /** Test-only override for single-video YouTube metadata resolution. */
  videoResolver?: VideoResolver;
  /** Test-only override for the YouTube channel-info fetcher (#106). */
  channelInfoFetcher?: typeof fetchChannelInfo;
  /** Test-only override for the PeerTube channel-creation orchestrator (#108). */
  ptChannelCreator?: typeof createChannelFromYoutube;
}

export interface BuildServerOptions {
  webRoot?: string;
}

export function buildServer(ctx: ServerContext, opts: BuildServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });

  // CORS — permit Vite dev server during development.
  app.register(fastifyCors, {
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
    credentials: true,
  });

  // Decorate context onto the instance so route plugins can reach it.
  app.decorate("ctx", ctx);

  // ── HTTP access log ──────────────────────────────────────────────
  //
  // One line per request: method, path, status, duration. Routed by
  // status class: 2xx/3xx → info, 4xx → warn, 5xx → error. The SSE
  // events stream is excluded because its responses are long-lived and
  // would otherwise produce a stale entry per client. Static asset GETs
  // (anything not under /api/) are logged at debug to avoid drowning
  // the info stream when the SPA loads.
  app.addHook("onRequest", async (req) => {
    (req as unknown as { _t0: number })._t0 = Date.now();
  });
  app.addHook("onResponse", async (req, reply) => {
    const url = req.raw.url ?? "";
    if (url.startsWith("/api/events")) return;
    const ms = Date.now() - ((req as unknown as { _t0?: number })._t0 ?? Date.now());
    const status = reply.statusCode;
    const line = `HTTP ${req.method} ${url} → ${status} (${ms}ms)`;
    const isApi = url.startsWith("/api/");
    if (status >= 500) ctx.logger.error(line);
    else if (status >= 400) ctx.logger.warn(line);
    else if (isApi) ctx.logger.info(line);
    else ctx.logger.debug(line);
  });

  // Basic liveness + storage info.
  app.get("/api/health", async () => {
    const storage = getStorageInfo(ctx.paths.dataDir, ctx.logger);
    ctx.logger.debug(
      `storage: disk_total=${fmtBytes(storage.disk_total_bytes)}, ` +
        `disk_free=${fmtBytes(storage.disk_free_bytes)}, ` +
        `data_dir=${fmtBytes(storage.data_dir_bytes)} (${ctx.paths.dataDir})`,
    );
    return {
      status: "ok",
      version: process.env.npm_package_version ?? "dev",
      storage,
    };
  });

  // Settings API (GET/PUT /api/settings, POST /api/settings/token).
  app.register(registerSettingsRoutes);

  // PeerTube status + channels API.
  app.register(registerPeertubeRoutes);

  // YouTube → PeerTube channel mapping API.
  app.register(registerChannelRoutes);

  // Video list / detail API.
  app.register(registerVideoRoutes);

  // SSE events stream.
  app.register(registerEventsRoutes);

  // Static Vue build — mounted only if the directory exists.
  if (opts.webRoot && existsSync(opts.webRoot)) {
    app.register(fastifyStatic, {
      root: opts.webRoot,
      prefix: "/",
      wildcard: false,
    });
    // SPA fallback for client-side routes.
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith("/api/")) {
        reply.code(404).send({ error: "Not Found" });
        return;
      }
      reply.sendFile("index.html");
    });
  }

  return app;
}

// ── Storage helpers ─────────────────────────────────────────────────

export interface StorageInfo {
  disk_total_bytes: number;
  disk_free_bytes: number;
  data_dir_bytes: number;
}

/**
 * Collect disk capacity and free space for the root filesystem (`/`),
 * plus the recursive size of `dataDir`.
 */
export function getStorageInfo(dataDir: string, logger: Logger): StorageInfo {
  let diskTotal = 0;
  let diskFree = 0;
  try {
    // Always query the root filesystem so we report the real system disk,
    // not a tmpfs or other special mount the data dir may reside on.
    const raw = execSync(`df -Pk /`, { encoding: "utf-8", timeout: 5000 });
    const cols = raw.trim().split("\n")[1]?.split(/\s+/);
    if (cols && cols.length >= 4) {
      diskTotal = parseInt(cols[1], 10) * 1024;  // 1K-blocks → bytes
      diskFree = parseInt(cols[3], 10) * 1024;
    }
  } catch (err) {
    logger.warn(`failed to read disk stats: ${err instanceof Error ? err.message : String(err)}`);
  }

  let dataDirSize = 0;
  try {
    dataDirSize = dirSizeRecursive(dataDir);
  } catch (err) {
    logger.warn(`failed to compute data_dir size: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { disk_total_bytes: diskTotal, disk_free_bytes: diskFree, data_dir_bytes: dataDirSize };
}

/** Recursively sum file sizes under `dir`. */
function dirSizeRecursive(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirSizeRecursive(p);
    } else if (entry.isFile()) {
      try { total += statSync(p).size; } catch { /* skip unreadable */ }
    }
  }
  return total;
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

declare module "fastify" {
  interface FastifyInstance {
    ctx: ServerContext;
  }
}
