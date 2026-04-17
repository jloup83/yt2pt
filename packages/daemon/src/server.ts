import Fastify, { type FastifyInstance } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import type { Database } from "better-sqlite3";
import type { Config, Logger, ResolvedPaths } from "@yt2pt/shared";
import type { PeertubeConnection } from "./peertube/connection";

export interface ServerContext {
  config: Config;
  paths: ResolvedPaths;
  db: Database;
  logger: Logger;
  peertube?: PeertubeConnection;
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
