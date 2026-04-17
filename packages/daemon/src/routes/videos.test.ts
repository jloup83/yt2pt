import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "../db/schema";
import { insertChannel } from "../db/channels";
import { insertVideo, updateVideo } from "../db/videos";
import { buildServer, type ServerContext } from "../server";
import {
  listVideosWithChannel,
  getVideoWithChannel,
  parseStatuses,
} from "./videos";
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
    ytdlp: { format: "bv*+ba/b", merge_output_format: "mkv", thumbnail_format: "jpg" },
    peertube: {
      instance_url: "https://peertube.example", api_token: "",
      channel_id: "", privacy: "public", language: "", licence: "",
      comments_policy: "enabled", wait_transcoding: true, generate_transcription: true,
    },
  };
}

interface TestCtx {
  ctx: ServerContext;
  cleanup: () => void;
}

function makeCtx(): TestCtx {
  const dir = mkdtempSync(join(tmpdir(), "yt2pt-videos-"));
  writeFileSync(join(dir, "yt2pt.conf.toml"), "", "utf-8");
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const logger = { error: () => {}, info: () => {}, debug: () => {} } as unknown as Logger;
  const paths: ResolvedPaths = {
    mode: "dev",
    configPath: join(dir, "yt2pt.conf.toml"),
    dataDir: dir,
    logDir: dir,
    binDir: dir,
  };
  return {
    ctx: { config: makeConfig(), paths, db, logger },
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seed(ctx: ServerContext): { channelA: number; channelB: number } {
  const a = insertChannel(ctx.db, {
    youtube_channel_url: "https://www.youtube.com/@alpha",
    youtube_channel_name: "Alpha",
    peertube_channel_id: "1",
  });
  const b = insertChannel(ctx.db, {
    youtube_channel_url: "https://www.youtube.com/@beta",
    youtube_channel_name: "Beta",
    peertube_channel_id: "2",
  });
  insertVideo(ctx.db, { youtube_video_id: "v1", channel_id: a.id, title: "A1", status: "UPLOADED" });
  insertVideo(ctx.db, { youtube_video_id: "v2", channel_id: a.id, title: "A2", status: "DOWNLOAD_QUEUED" });
  const v3 = insertVideo(ctx.db, { youtube_video_id: "v3", channel_id: b.id, title: "B1", status: "UPLOADING" });
  // Make v3 the most-recently-updated so default sort surfaces it first.
  updateVideo(ctx.db, v3.id, { progress_pct: 50 });
  return { channelA: a.id, channelB: b.id };
}

// ── helpers ─────────────────────────────────────────────────────────

test("parseStatuses() accepts valid CSV and rejects unknown tokens", () => {
  assert.equal(parseStatuses(undefined), undefined);
  assert.equal(parseStatuses(""), undefined);
  assert.deepEqual(parseStatuses("UPLOADED"), ["UPLOADED"]);
  assert.deepEqual(parseStatuses("UPLOADED,UPLOADING"), ["UPLOADED", "UPLOADING"]);
  assert.equal(parseStatuses("NOT_A_STATUS"), null);
  assert.equal(parseStatuses("UPLOADED,BOGUS"), null);
});

test("listVideosWithChannel() joins channel name and paginates", () => {
  const { ctx, cleanup } = makeCtx();
  try {
    seed(ctx);
    const all = listVideosWithChannel(ctx.db, {
      page: 1, perPage: 50, sort: "updated_at", order: "desc",
    });
    assert.equal(all.total, 3);
    assert.equal(all.videos.length, 3);
    // v3 got the most recent updated_at
    assert.equal(all.videos[0].youtube_video_id, "v3");
    assert.equal(all.videos[0].channel_name, "Beta");
  } finally {
    cleanup();
  }
});

test("listVideosWithChannel() filters by channel and status", () => {
  const { ctx, cleanup } = makeCtx();
  try {
    const { channelA } = seed(ctx);
    const byChannel = listVideosWithChannel(ctx.db, {
      channelId: channelA, page: 1, perPage: 50, sort: "created_at", order: "asc",
    });
    assert.equal(byChannel.total, 2);
    assert.ok(byChannel.videos.every((v) => v.channel_id === channelA));

    const byStatus = listVideosWithChannel(ctx.db, {
      statuses: ["UPLOADED", "UPLOADING"], page: 1, perPage: 50, sort: "created_at", order: "asc",
    });
    assert.equal(byStatus.total, 2);
    assert.deepEqual(
      byStatus.videos.map((v) => v.status).sort(),
      ["UPLOADED", "UPLOADING"]
    );
  } finally {
    cleanup();
  }
});

test("listVideosWithChannel() respects perPage cap + page offset", () => {
  const { ctx, cleanup } = makeCtx();
  try {
    seed(ctx);
    const p1 = listVideosWithChannel(ctx.db, { page: 1, perPage: 2, sort: "created_at", order: "asc" });
    const p2 = listVideosWithChannel(ctx.db, { page: 2, perPage: 2, sort: "created_at", order: "asc" });
    assert.equal(p1.videos.length, 2);
    assert.equal(p2.videos.length, 1);
    assert.equal(p1.total, 3);
    assert.notEqual(p1.videos[0].id, p2.videos[0].id);
  } finally {
    cleanup();
  }
});

test("getVideoWithChannel() returns row with channel_name or null", () => {
  const { ctx, cleanup } = makeCtx();
  try {
    seed(ctx);
    const hit = getVideoWithChannel(ctx.db, 1);
    assert.ok(hit);
    assert.equal(hit?.channel_name, "Alpha");
    assert.equal(getVideoWithChannel(ctx.db, 9999), null);
  } finally {
    cleanup();
  }
});

// ── HTTP ────────────────────────────────────────────────────────────

test("GET /api/videos returns paginated list with defaults", async () => {
  const { ctx, cleanup } = makeCtx();
  try {
    seed(ctx);
    const app = buildServer(ctx);
    const res = await app.inject({ method: "GET", url: "/api/videos" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { videos: { id: number }[]; total: number; page: number; per_page: number };
    assert.equal(body.total, 3);
    assert.equal(body.page, 1);
    assert.equal(body.per_page, 50);
    assert.equal(body.videos.length, 3);
    await app.close();
  } finally {
    cleanup();
  }
});

test("GET /api/videos filters by channel + status CSV", async () => {
  const { ctx, cleanup } = makeCtx();
  try {
    const { channelA } = seed(ctx);
    const app = buildServer(ctx);

    const byChannel = await app.inject({ method: "GET", url: `/api/videos?channel=${channelA}` });
    const bcBody = byChannel.json() as { total: number };
    assert.equal(bcBody.total, 2);

    const byStatus = await app.inject({ method: "GET", url: "/api/videos?status=UPLOADED,UPLOADING" });
    const bsBody = byStatus.json() as { total: number };
    assert.equal(bsBody.total, 2);

    await app.close();
  } finally {
    cleanup();
  }
});

test("GET /api/videos 400s on invalid status and channel", async () => {
  const { ctx, cleanup } = makeCtx();
  try {
    const app = buildServer(ctx);
    const badStatus = await app.inject({ method: "GET", url: "/api/videos?status=NOPE" });
    assert.equal(badStatus.statusCode, 400);
    const badChannel = await app.inject({ method: "GET", url: "/api/videos?channel=abc" });
    assert.equal(badChannel.statusCode, 400);
    await app.close();
  } finally {
    cleanup();
  }
});

test("GET /api/videos/:id returns 200 / 404 / 400", async () => {
  const { ctx, cleanup } = makeCtx();
  try {
    seed(ctx);
    const app = buildServer(ctx);
    const ok = await app.inject({ method: "GET", url: "/api/videos/1" });
    assert.equal(ok.statusCode, 200);
    assert.equal((ok.json() as { channel_name: string }).channel_name, "Alpha");

    const missing = await app.inject({ method: "GET", url: "/api/videos/9999" });
    assert.equal(missing.statusCode, 404);

    const bad = await app.inject({ method: "GET", url: "/api/videos/abc" });
    assert.equal(bad.statusCode, 400);
    await app.close();
  } finally {
    cleanup();
  }
});
