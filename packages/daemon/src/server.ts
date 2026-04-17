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
