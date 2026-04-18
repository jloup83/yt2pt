import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "../db/schema";
import { insertChannel } from "../db/channels";
import { insertVideo } from "../db/videos";
import { buildServer } from "../server";
import { normalizeYoutubeChannelUrl, summarizeChannel } from "./channels";
import type { Config, Logger, ResolvedPaths } from "@yt2pt/shared";

function makeConfig(): Config {
  return {
    yt2pt: {
      data_dir: "/tmp", log_dir: "/tmp", log_level: "info",
      overwrite_existing: false, skip_downloaded: true,
      remove_video_after_upload: false, remove_video_after_metadata_conversion: false,
    },
    http: { port: 8090, bind: "0.0.0.0" },
    workers: { download_concurrency: 1, convert_concurrency: 1, upload_concurrency: 1 },
    ytdlp: { format: "bv*+ba/b", merge_output_format: "mkv", thumbnail_format: "jpg", rate_limit_enabled: true, rate_limit: "10M" },
    peertube: {
      instance_url: "https://peertube.example", api_token: "",
      channel_id: "", privacy: "public", language: "", licence: "",
      comments_policy: "enabled", wait_transcoding: true, generate_transcription: true,
    },
  };
}

interface TestCtx {
  config: Config;
  paths: ResolvedPaths;
  db: Database.Database;
  logger: Logger;
  cleanup: () => void;
}

function makeCtx(): TestCtx {
  const dir = mkdtempSync(join(tmpdir(), "yt2pt-channels-"));
  writeFileSync(join(dir, "yt2pt.conf.toml"), "", "utf-8");
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as unknown as Logger;
  // binDir points at an empty dir → findYtDlpBinary throws inside POST and
  // name resolution is skipped (the row still gets inserted).
  const paths: ResolvedPaths = { mode: "dev", configPath: join(dir, "yt2pt.conf.toml"), dataDir: dir, logDir: dir, binDir: join(dir, "empty-bin") };
  return {
    config: makeConfig(), paths, db, logger,
    cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

// ── normalizeYoutubeChannelUrl ──────────────────────────────────────

test("normalizeYoutubeChannelUrl accepts @handle / channel / c / user forms", () => {
  const cases: [string, string][] = [
    ["https://www.youtube.com/@SomeChannel", "https://www.youtube.com/@SomeChannel"],
    ["https://youtube.com/@Some.Channel_-1/", "https://www.youtube.com/@Some.Channel_-1"],
    ["https://www.youtube.com/channel/UC123abc", "https://www.youtube.com/channel/UC123abc"],
    ["https://www.youtube.com/c/CoolName", "https://www.youtube.com/c/CoolName"],
    ["https://www.youtube.com/user/legacy", "https://www.youtube.com/user/legacy"],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(normalizeYoutubeChannelUrl(raw), expected, raw);
  }
});

test("normalizeYoutubeChannelUrl rejects non-YouTube or non-channel URLs", () => {
  for (const raw of [
    "https://www.example.com/@foo",
    "https://www.youtube.com/watch?v=q5Mq4kEa7pA",
    "not a url",
    "https://www.youtube.com/",
  ]) {
    assert.equal(normalizeYoutubeChannelUrl(raw), null, raw);
  }
});

// ── summarizeChannel ────────────────────────────────────────────────

test("summarizeChannel counts videos per status", () => {
  const ctx = makeCtx();
  const channel = insertChannel(ctx.db, {
    youtube_channel_url: "https://www.youtube.com/@test",
    peertube_channel_id: "5",
  });
  insertVideo(ctx.db, { youtube_video_id: "a", channel_id: channel.id, status: "DOWNLOAD_QUEUED" });
  insertVideo(ctx.db, { youtube_video_id: "b", channel_id: channel.id, status: "DOWNLOAD_QUEUED" });
  insertVideo(ctx.db, { youtube_video_id: "c", channel_id: channel.id, status: "UPLOADED" });
  const sum = summarizeChannel(ctx.db, channel, ctx.paths.dataDir);
  assert.equal(sum.video_count, 3);
  assert.equal(sum.status_summary.DOWNLOAD_QUEUED, 2);
  assert.equal(sum.status_summary.UPLOADED, 1);
  ctx.cleanup();
});

// ── Routes ──────────────────────────────────────────────────────────

test("GET /api/channels returns [] when none are mapped", async () => {
  const ctx = makeCtx();
  const app = buildServer(ctx);
  const res = await app.inject({ method: "GET", url: "/api/channels" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { channels: [] });
  await app.close();
  ctx.cleanup();
});

test("POST /api/channels validates body and URL", async () => {
  const ctx = makeCtx();
  const app = buildServer(ctx);

  // missing fields
  let res = await app.inject({ method: "POST", url: "/api/channels", payload: {} });
  assert.equal(res.statusCode, 400);

  // invalid URL
  res = await app.inject({
    method: "POST", url: "/api/channels",
    payload: { youtube_channel_url: "https://example.com/foo", peertube_channel_id: "5" },
  });
  assert.equal(res.statusCode, 400);

  await app.close();
  ctx.cleanup();
});

test("POST /api/channels inserts, normalizes the URL, returns the summary", async () => {
  const ctx = makeCtx();
  const app = buildServer(ctx);
  const res = await app.inject({
    method: "POST", url: "/api/channels",
    payload: { youtube_channel_url: "https://youtube.com/@foo/", peertube_channel_id: 5 },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.youtube_channel_url, "https://www.youtube.com/@foo");
  assert.equal(body.peertube_channel_id, "5");
  assert.equal(body.video_count, 0);
  assert.deepEqual(body.status_summary, {});
  assert.ok(typeof body.id === "number");
  await app.close();
  ctx.cleanup();
});

test("POST /api/channels is idempotent — second call on same URL returns existing mapping", async () => {
  const ctx = makeCtx();
  const app = buildServer(ctx);
  const payload = { youtube_channel_url: "https://www.youtube.com/@foo", peertube_channel_id: "5" };
  const r1 = await app.inject({ method: "POST", url: "/api/channels", payload });
  assert.equal(r1.statusCode, 201);
  const r2 = await app.inject({ method: "POST", url: "/api/channels", payload });
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.json().id, r1.json().id);
  await app.close();
  ctx.cleanup();
});

test("DELETE /api/channels/:id removes the row; 404 when missing; 400 on bad id", async () => {
  const ctx = makeCtx();
  const channel = insertChannel(ctx.db, {
    youtube_channel_url: "https://www.youtube.com/@gone",
    peertube_channel_id: "5",
  });
  const app = buildServer(ctx);

  const bad = await app.inject({ method: "DELETE", url: "/api/channels/abc" });
  assert.equal(bad.statusCode, 400);

  const miss = await app.inject({ method: "DELETE", url: "/api/channels/9999" });
  assert.equal(miss.statusCode, 404);

  const ok = await app.inject({ method: "DELETE", url: `/api/channels/${channel.id}` });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().status, "deleted");

  const after = await app.inject({ method: "GET", url: "/api/channels" });
  assert.deepEqual(after.json(), { channels: [] });

  await app.close();
  ctx.cleanup();
});

test("POST /api/channels/:id/sync returns 503 without a sync engine, 202 with one", async () => {
  const ctx = makeCtx();
  const channel = insertChannel(ctx.db, {
    youtube_channel_url: "https://www.youtube.com/@tosync",
    peertube_channel_id: "5",
  });
  const app = buildServer(ctx);

  const miss = await app.inject({ method: "POST", url: "/api/channels/9999/sync" });
  assert.equal(miss.statusCode, 404);

  // No sync engine wired → 503.
  const noSync = await app.inject({ method: "POST", url: `/api/channels/${channel.id}/sync` });
  assert.equal(noSync.statusCode, 503);

  await app.close();
  ctx.cleanup();
});

// ── Avatar / banner endpoints ───────────────────────────────────────

import { mkdirSync, writeFileSync as _writeFileSync } from "node:fs";
import { join as _join } from "node:path";
import { sanitize as _sanitize } from "../workers/paths";

test("GET /api/channels/:id/avatar streams the file; 404 when missing", async () => {
  const ctx = makeCtx();
  const channel = insertChannel(ctx.db, {
    youtube_channel_url: "https://www.youtube.com/@withavatar",
    youtube_channel_name: "With Avatar",
    peertube_channel_id: "1",
  });
  const app = buildServer(ctx);

  // 404 before the avatar file exists.
  let res = await app.inject({ method: "GET", url: `/api/channels/${channel.id}/avatar` });
  assert.equal(res.statusCode, 404);

  // Write a fake avatar.png into the expected location.
  const slug = _sanitize("With Avatar");
  const dir = _join(ctx.paths.dataDir, "downloaded_from_youtube", slug, "channel_info");
  mkdirSync(dir, { recursive: true });
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic
  _writeFileSync(_join(dir, "avatar.png"), bytes);

  res = await app.inject({ method: "GET", url: `/api/channels/${channel.id}/avatar` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/png");
  assert.deepEqual(res.rawPayload, bytes);

  // 404 for unknown channel.
  const miss = await app.inject({ method: "GET", url: "/api/channels/9999/avatar" });
  assert.equal(miss.statusCode, 404);

  // Banner still missing → 404.
  const banner = await app.inject({ method: "GET", url: `/api/channels/${channel.id}/banner` });
  assert.equal(banner.statusCode, 404);

  await app.close();
  ctx.cleanup();
});

test("summarizeChannel reports avatar_url / banner_url when assets exist", () => {
  const ctx = makeCtx();
  const channel = insertChannel(ctx.db, {
    youtube_channel_url: "https://www.youtube.com/@summary",
    youtube_channel_name: "Summary Channel",
    peertube_channel_id: "2",
  });
  // No files yet → both null.
  let sum = summarizeChannel(ctx.db, channel, ctx.paths.dataDir);
  assert.equal(sum.avatar_url, null);
  assert.equal(sum.banner_url, null);

  const slug = _sanitize("Summary Channel");
  const dir = _join(ctx.paths.dataDir, "downloaded_from_youtube", slug, "channel_info");
  mkdirSync(dir, { recursive: true });
  _writeFileSync(_join(dir, "avatar.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
  sum = summarizeChannel(ctx.db, channel, ctx.paths.dataDir);
  assert.equal(sum.avatar_url, `/api/channels/${channel.id}/avatar`);
  assert.equal(sum.banner_url, null);

  ctx.cleanup();
});
