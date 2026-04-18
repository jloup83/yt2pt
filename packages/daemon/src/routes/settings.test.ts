import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import Database from "better-sqlite3";
import { runMigrations } from "../db/schema";
import { buildServer } from "../server";
import { redactConfig, validatePatch, mergeConfig } from "./settings";
import type { Config, Logger, ResolvedPaths } from "@yt2pt/shared";
import type { PeertubeConnection } from "../peertube/connection";

// ── Fixtures ────────────────────────────────────────────────────────

function makeConfig(): Config {
  return {
    yt2pt: {
      data_dir: "/tmp",
      log_dir: "/tmp",
      log_level: "info",
      overwrite_existing: false,
      skip_downloaded: true,
      remove_video_after_upload: false,
      remove_video_after_metadata_conversion: false,
    },
    http: { port: 8090, bind: "0.0.0.0" },
    workers: { download_concurrency: 1, convert_concurrency: 1, upload_concurrency: 1 },
    ytdlp: { format: "bv*+ba/b", merge_output_format: "mkv", thumbnail_format: "jpg", rate_limit_enabled: true, rate_limit: "10M" },
    peertube: {
      instance_url: "https://peertube.example",
      api_token: "secret-token",
      channel_id: "",
      privacy: "public",
      language: "",
      licence: "",
      comments_policy: "enabled",
      wait_transcoding: true,
      generate_transcription: true,
    },
  };
}

interface TestCtx {
  config: Config;
  paths: ResolvedPaths;
  db: Database.Database;
  logger: Logger;
  peertube?: PeertubeConnection;
  cleanup: () => void;
}

function makeCtx(peertube?: PeertubeConnection): TestCtx {
  const dir = mkdtempSync(join(tmpdir(), "yt2pt-settings-"));
  const configPath = join(dir, "yt2pt.conf.toml");
  writeFileSync(configPath, "", "utf-8");

  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as unknown as Logger;
  const paths: ResolvedPaths = {
    mode: "dev",
    configPath,
    dataDir: dir,
    logDir: dir,
    binDir: dir,
  };

  return {
    config: makeConfig(),
    paths,
    db,
    logger,
    peertube,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ── Pure helpers ────────────────────────────────────────────────────

test("redactConfig masks a present token and leaves empty token empty", () => {
  const c = makeConfig();
  assert.equal(redactConfig(c).peertube.api_token, "****");
  c.peertube.api_token = "";
  assert.equal(redactConfig(c).peertube.api_token, "");
});

test("redactConfig does not mutate its input", () => {
  const c = makeConfig();
  const before = c.peertube.api_token;
  redactConfig(c);
  assert.equal(c.peertube.api_token, before);
});

test("validatePatch accepts a valid partial patch", () => {
  const errs = validatePatch(
    { yt2pt: { log_level: "debug" }, workers: { download_concurrency: 4 } },
    makeConfig()
  );
  assert.deepEqual(errs, []);
});

test("validatePatch rejects unknown section / key / types", () => {
  const cur = makeConfig();
  const errs = validatePatch(
    {
      yt2pt: { log_level: "verbose", bogus: true },
      foo: { bar: 1 },
      http: { port: 70000 },
      workers: { download_concurrency: 0 },
      peertube: { privacy: "everyone", api_token: "****" },
    },
    cur
  );
  const paths = errs.map((e) => e.path);
  assert.ok(paths.includes("foo"), "unknown section");
  assert.ok(paths.includes("yt2pt.bogus"), "unknown key");
  // validatePatch returns early when structural errors are found; we still
  // assert that at least one known section was short-circuited too.
  assert.ok(errs.length >= 2);
});

test("validatePatch type/range checks (second pass)", () => {
  const cur = makeConfig();
  const errs = validatePatch(
    {
      http: { port: 70000 },
      workers: { download_concurrency: 0 },
      peertube: { privacy: "everyone", api_token: "****" },
      yt2pt: { log_level: "verbose" },
    },
    cur
  );
  const paths = errs.map((e) => e.path);
  for (const p of ["http.port", "workers.download_concurrency", "peertube.privacy", "peertube.api_token", "yt2pt.log_level"]) {
    assert.ok(paths.includes(p), `expected error for ${p}, got ${paths.join(",")}`);
  }
});

test("mergeConfig overlays only provided keys", () => {
  const cur = makeConfig();
  const next = mergeConfig(cur, { yt2pt: { log_level: "debug" } });
  assert.equal(next.yt2pt.log_level, "debug");
  assert.equal(next.yt2pt.data_dir, cur.yt2pt.data_dir);
  assert.equal(next.peertube.api_token, cur.peertube.api_token);
});

// ── Routes ──────────────────────────────────────────────────────────

test("GET /api/settings returns the config with the token masked", async () => {
  const ctx = makeCtx();
  const app = buildServer(ctx);
  const res = await app.inject({ method: "GET", url: "/api/settings" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.peertube.api_token, "****");
  assert.equal(body.peertube.instance_url, "https://peertube.example");
  await app.close();
  ctx.cleanup();
});

test("PUT /api/settings persists allowed fields and updates in-memory config", async () => {
  const ctx = makeCtx();
  const app = buildServer(ctx);
  const res = await app.inject({
    method: "PUT",
    url: "/api/settings",
    payload: { yt2pt: { log_level: "debug" }, workers: { upload_concurrency: 3 } },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(ctx.config.yt2pt.log_level, "debug");
  assert.equal(ctx.config.workers.upload_concurrency, 3);

  // File was written and round-trips.
  const written = parseToml(readFileSync(ctx.paths.configPath, "utf-8")) as Record<string, Record<string, unknown>>;
  assert.equal(written.yt2pt.log_level, "debug");
  assert.equal(written.workers.upload_concurrency, 3);
  // Token was NOT masked in the written file.
  assert.equal(written.peertube.api_token, "secret-token");

  await app.close();
  ctx.cleanup();
});

test("PUT /api/settings returns 400 on validation failure and does not write", async () => {
  const ctx = makeCtx();
  const app = buildServer(ctx);
  const res = await app.inject({
    method: "PUT",
    url: "/api/settings",
    payload: { http: { port: 99999 } },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.error, "validation failed");
  assert.ok(Array.isArray(body.details) && body.details.length > 0);
  // File remains empty.
  assert.equal(readFileSync(ctx.paths.configPath, "utf-8"), "");
  await app.close();
  ctx.cleanup();
});

test("PUT /api/settings rejects the masked token as an actual token value", async () => {
  const ctx = makeCtx();
  const app = buildServer(ctx);
  const res = await app.inject({
    method: "PUT",
    url: "/api/settings",
    payload: { peertube: { api_token: "****" } },
  });
  assert.equal(res.statusCode, 400);
  const paths = res.json().details.map((d: { path: string }) => d.path);
  assert.ok(paths.includes("peertube.api_token"));
  await app.close();
  ctx.cleanup();
});

test("POST /api/settings/token requires username and password", async () => {
  const ctx = makeCtx();
  const app = buildServer(ctx);
  const res = await app.inject({
    method: "POST",
    url: "/api/settings/token",
    payload: { username: "admin" },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
  ctx.cleanup();
});

test("POST /api/settings/token returns 503 when peertube is not wired", async () => {
  const ctx = makeCtx();
  const app = buildServer(ctx);
  const res = await app.inject({
    method: "POST",
    url: "/api/settings/token",
    payload: { username: "admin", password: "secret" },
  });
  assert.equal(res.statusCode, 503);
  await app.close();
  ctx.cleanup();
});

test("POST /api/settings/token delegates to peertube.acquireToken and masks success", async () => {
  let called: { u: string; p: string } | null = null;
  const fakePeertube = {
    async acquireToken(u: string, p: string) {
      called = { u, p };
      return { success: true };
    },
  } as unknown as PeertubeConnection;
  const ctx = makeCtx(fakePeertube);
  const app = buildServer(ctx);
  const res = await app.inject({
    method: "POST",
    url: "/api/settings/token",
    payload: { username: "admin", password: "secret" },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.success, true);
  assert.equal(body.token, "****");
  assert.deepEqual(called, { u: "admin", p: "secret" });
  await app.close();
  ctx.cleanup();
});

test("POST /api/settings/token returns 401 on acquireToken failure", async () => {
  const fakePeertube = {
    async acquireToken() {
      return { success: false, error: "bad credentials" };
    },
  } as unknown as PeertubeConnection;
  const ctx = makeCtx(fakePeertube);
  const app = buildServer(ctx);
  const res = await app.inject({
    method: "POST",
    url: "/api/settings/token",
    payload: { username: "admin", password: "wrong" },
  });
  assert.equal(res.statusCode, 401);
  const body = res.json();
  assert.equal(body.success, false);
  assert.equal(body.error, "bad credentials");
  await app.close();
  ctx.cleanup();
});
