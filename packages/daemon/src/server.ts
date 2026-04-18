import Fastify, { type FastifyInstance } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
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

  // Basic liveness.
  app.get("/api/health", async () => ({
    status: "ok",
    version: process.env.npm_package_version ?? "dev",
  }));

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

declare module "fastify" {
  interface FastifyInstance {
    ctx: ServerContext;
  }
}
