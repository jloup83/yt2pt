import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { runMigrations } from "./db/schema";
import { buildServer } from "./server";
import type { Config, Logger, ResolvedPaths } from "@yt2pt/shared";

function makeCtx() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  const config = {
    yt2pt: { data_dir: "/tmp", log_dir: "/tmp", log_level: "error" },
    http: { port: 0, bind: "127.0.0.1" },
    workers: { download_concurrency: 1, convert_concurrency: 1, upload_concurrency: 1 },
    ytdlp: { format: "", merge_output_format: "", thumbnail_format: "" },
    peertube: {
      instance_url: "", api_token: "", channel_id: "", privacy: "public",
      language: "", licence: "", comments_policy: "enabled",
      wait_transcoding: false, generate_transcription: false,
    },
  } as unknown as Config;

  const logger = {
    error: () => {}, info: () => {}, debug: () => {},
  } as unknown as Logger;

  const paths: ResolvedPaths = {
    mode: "dev",
    configPath: "/tmp/yt2pt.conf.toml",
    dataDir: "/tmp",
    logDir: "/tmp",
    binDir: "/tmp",
  };

  return { config, paths, db, logger };
}

test("GET /api/health returns ok", async () => {
  const ctx = makeCtx();
  const app = buildServer(ctx);
  const res = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, "ok");
  await app.close();
  ctx.db.close();
});

test("unknown /api route returns 404 JSON", async () => {
  const ctx = makeCtx();
  const app = buildServer(ctx);
  const res = await app.inject({ method: "GET", url: "/api/does-not-exist" });
  assert.equal(res.statusCode, 404);
  await app.close();
  ctx.db.close();
});

test("CORS preflight from Vite origin succeeds", async () => {
  const ctx = makeCtx();
  const app = buildServer(ctx);
  const res = await app.inject({
    method: "OPTIONS",
    url: "/api/health",
    headers: {
      origin: "http://localhost:5173",
      "access-control-request-method": "GET",
    },
  });
  assert.ok(res.statusCode === 204 || res.statusCode === 200, `status=${res.statusCode}`);
  assert.equal(res.headers["access-control-allow-origin"], "http://localhost:5173");
  await app.close();
  ctx.db.close();
});

test("server listens and closes cleanly", async () => {
  const ctx = makeCtx();
  const app = buildServer(ctx);
  const addr = await app.listen({ host: "127.0.0.1", port: 0 });
  assert.match(addr, /^http:\/\/127\.0\.0\.1:\d+$/);
  await app.close();
  ctx.db.close();
});
