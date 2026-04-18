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
import {
  extractYoutubeVideoId,
  normalizeYoutubeVideoUrl,
  type ResolvedYoutubeVideo,
  type VideoResolver,
} from "./youtube-video";
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
  ctx: ServerContext;
  cleanup: () => void;
}

function makeCtx(): TestCtx {
  const dir = mkdtempSync(join(tmpdir(), "yt2pt-videos-"));
  writeFileSync(join(dir, "yt2pt.toml"), "", "utf-8");
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as unknown as Logger;
  const paths: ResolvedPaths = {
    mode: "dev",
    configPath: join(dir, "yt2pt.toml"),
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

// ── URL helpers ─────────────────────────────────────────────────────

test("extractYoutubeVideoId accepts watch / youtu.be / shorts / live forms", () => {
  const cases: [string, string][] = [
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtube.com/watch?v=dQw4w9WgXcQ&t=42", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?t=10", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/abcdefghijk", "abcdefghijk"],
    ["https://www.youtube.com/live/abcdefghijk", "abcdefghijk"],
    ["https://www.youtube.com/embed/abcdefghijk", "abcdefghijk"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(extractYoutubeVideoId(raw), expected, raw);
  }
});

test("extractYoutubeVideoId rejects non-YouTube or malformed URLs", () => {
  for (const raw of [
    "https://example.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=tooShort",
    "https://www.youtube.com/@SomeChannel",
    "not a url",
    "",
  ]) {
    assert.equal(extractYoutubeVideoId(raw), null, raw);
  }
});

test("normalizeYoutubeVideoUrl produces the canonical watch URL", () => {
  assert.equal(
    normalizeYoutubeVideoUrl("https://youtu.be/dQw4w9WgXcQ?t=10"),
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  );
  assert.equal(normalizeYoutubeVideoUrl("https://example.com/x"), null);
});

// ── POST /api/videos ────────────────────────────────────────────────

function fakeResolver(meta: Partial<ResolvedYoutubeVideo> & { youtube_video_id: string }): VideoResolver {
  return async () => ({
    title: meta.title ?? null,
    channel_name: meta.channel_name ?? null,
    channel_url: meta.channel_url ?? null,
    youtube_video_id: meta.youtube_video_id,
  });
}

function makeCtxWithResolver(resolver: VideoResolver): TestCtx {
  const t = makeCtx();
  t.ctx.videoResolver = resolver;
  return t;
}

test("POST /api/videos rejects missing fields", async () => {
  const { ctx, cleanup } = makeCtx();
  try {
    const app = buildServer(ctx);
    const r1 = await app.inject({ method: "POST", url: "/api/videos", payload: {} });
    assert.equal(r1.statusCode, 400);
    const r2 = await app.inject({
      method: "POST", url: "/api/videos",
      payload: { youtube_url: "https://youtu.be/dQw4w9WgXcQ" },
    });
    assert.equal(r2.statusCode, 400);
    await app.close();
  } finally {
    cleanup();
  }
});

test("POST /api/videos rejects an invalid YouTube URL", async () => {
  const { ctx, cleanup } = makeCtx();
  try {
    const app = buildServer(ctx);
    const res = await app.inject({
      method: "POST", url: "/api/videos",
      payload: { youtube_url: "https://example.com/watch?v=dQw4w9WgXcQ", peertube_channel_id: "5" },
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  } finally {
    cleanup();
  }
});

test("POST /api/videos creates a new channel mapping when the YT channel is unknown", async () => {
  const { ctx, cleanup } = makeCtxWithResolver(fakeResolver({
    youtube_video_id: "dQw4w9WgXcQ",
    title: "Never Gonna",
    channel_name: "Rick Astley",
    channel_url: "https://www.youtube.com/@RickAstley",
  }));
  try {
    const app = buildServer(ctx);
    const res = await app.inject({
      method: "POST", url: "/api/videos",
      payload: { youtube_url: "https://youtu.be/dQw4w9WgXcQ", peertube_channel_id: "5" },
    });
    assert.equal(res.statusCode, 202);
    const body = res.json();
    assert.equal(body.status, "queued");
    assert.ok(body.video_id > 0);
    assert.ok(body.channel_id > 0);

    const ch = ctx.db.prepare("SELECT * FROM channels WHERE id = ?").get(body.channel_id) as
      { youtube_channel_url: string; youtube_channel_name: string; peertube_channel_id: string };
    assert.equal(ch.youtube_channel_url, "https://www.youtube.com/@RickAstley");
    assert.equal(ch.youtube_channel_name, "Rick Astley");
    assert.equal(ch.peertube_channel_id, "5");

    const v = ctx.db.prepare("SELECT * FROM videos WHERE id = ?").get(body.video_id) as
      { youtube_video_id: string; status: string; channel_id: number; title: string };
    assert.equal(v.youtube_video_id, "dQw4w9WgXcQ");
    assert.equal(v.status, "DOWNLOAD_QUEUED");
    assert.equal(v.channel_id, body.channel_id);
    assert.equal(v.title, "Never Gonna");
    await app.close();
  } finally {
    cleanup();
  }
});

test("POST /api/videos reuses an existing channel mapping when PT target matches", async () => {
  const { ctx, cleanup } = makeCtxWithResolver(fakeResolver({
    youtube_video_id: "dQw4w9WgXcQ",
    channel_url: "https://www.youtube.com/@RickAstley",
    channel_name: "Rick Astley",
  }));
  try {
    const existing = insertChannel(ctx.db, {
      youtube_channel_url: "https://www.youtube.com/@RickAstley",
      peertube_channel_id: "5",
    });
    const app = buildServer(ctx);
    const res = await app.inject({
      method: "POST", url: "/api/videos",
      payload: { youtube_url: "https://youtu.be/dQw4w9WgXcQ", peertube_channel_id: "5" },
    });
    assert.equal(res.statusCode, 202);
    assert.equal(res.json().channel_id, existing.id);

    const count = ctx.db.prepare("SELECT COUNT(*) AS n FROM channels").get() as { n: number };
    assert.equal(count.n, 1);
    await app.close();
  } finally {
    cleanup();
  }
});

test("POST /api/videos returns 409 when YT channel maps to a different PT channel", async () => {
  const { ctx, cleanup } = makeCtxWithResolver(fakeResolver({
    youtube_video_id: "dQw4w9WgXcQ",
    channel_url: "https://www.youtube.com/@RickAstley",
  }));
  try {
    insertChannel(ctx.db, {
      youtube_channel_url: "https://www.youtube.com/@RickAstley",
      peertube_channel_id: "5",
    });
    const app = buildServer(ctx);
    const res = await app.inject({
      method: "POST", url: "/api/videos",
      payload: { youtube_url: "https://youtu.be/dQw4w9WgXcQ", peertube_channel_id: "7" },
    });
    assert.equal(res.statusCode, 409);
    const body = res.json();
    assert.equal(body.existing_peertube_channel_id, "5");
    assert.equal(body.requested_peertube_channel_id, "7");

    const vc = ctx.db.prepare("SELECT COUNT(*) AS n FROM videos").get() as { n: number };
    assert.equal(vc.n, 0);
    await app.close();
  } finally {
    cleanup();
  }
});

test("POST /api/videos returns 409 when the video is already tracked", async () => {
  const { ctx, cleanup } = makeCtxWithResolver(fakeResolver({
    youtube_video_id: "dQw4w9WgXcQ",
    channel_url: "https://www.youtube.com/@RickAstley",
  }));
  try {
    const ch = insertChannel(ctx.db, {
      youtube_channel_url: "https://www.youtube.com/@RickAstley",
      peertube_channel_id: "5",
    });
    insertVideo(ctx.db, {
      youtube_video_id: "dQw4w9WgXcQ",
      channel_id: ch.id,
      status: "UPLOADED",
    });
    const app = buildServer(ctx);
    const res = await app.inject({
      method: "POST", url: "/api/videos",
      payload: { youtube_url: "https://youtu.be/dQw4w9WgXcQ", peertube_channel_id: "5" },
    });
    assert.equal(res.statusCode, 409);
    const body = res.json();
    assert.equal(body.error, "video already tracked");
    assert.equal(body.status, "UPLOADED");
    await app.close();
  } finally {
    cleanup();
  }
});

test("POST /api/videos returns 502 when yt-dlp metadata fetch fails", async () => {
  const { ctx, cleanup } = makeCtxWithResolver(async () => { throw new Error("boom"); });
  try {
    const app = buildServer(ctx);
    const res = await app.inject({
      method: "POST", url: "/api/videos",
      payload: { youtube_url: "https://youtu.be/dQw4w9WgXcQ", peertube_channel_id: "5" },
    });
    assert.equal(res.statusCode, 502);
    await app.close();
  } finally {
    cleanup();
  }
});

// ── upload_date sorting (issue #109) ─────────────────────────────────

test("listVideosWithChannel() sorts by upload_date desc (nulls last)", () => {
  const tc = makeCtx();
  const ch = insertChannel(tc.ctx.db, {
    youtube_channel_url: "https://www.youtube.com/@ud",
    peertube_channel_id: "1",
  });
  insertVideo(tc.ctx.db, {
    youtube_video_id: "old", channel_id: ch.id, title: "old",
    status: "UPLOADED", upload_date: "2020-01-01",
  });
  insertVideo(tc.ctx.db, {
    youtube_video_id: "new", channel_id: ch.id, title: "new",
    status: "UPLOADED", upload_date: "2025-12-31",
  });
  insertVideo(tc.ctx.db, {
    youtube_video_id: "nul", channel_id: ch.id, title: "nul",
    status: "UPLOADED", upload_date: null,
  });

  const res = listVideosWithChannel(tc.ctx.db, {
    page: 1, perPage: 50, sort: "upload_date", order: "desc",
  });
  assert.deepEqual(res.videos.map((v) => v.youtube_video_id), ["new", "old", "nul"]);
  tc.cleanup();
});

test("GET /api/videos accepts sort=upload_date", async () => {
  const tc = makeCtx();
  const ch = insertChannel(tc.ctx.db, {
    youtube_channel_url: "https://www.youtube.com/@ud2",
    peertube_channel_id: "1",
  });
  insertVideo(tc.ctx.db, {
    youtube_video_id: "a", channel_id: ch.id, status: "UPLOADED", upload_date: "2024-05-01",
  });
  insertVideo(tc.ctx.db, {
    youtube_video_id: "b", channel_id: ch.id, status: "UPLOADED", upload_date: "2024-06-01",
  });

  const app = buildServer(tc.ctx);
  const res = await app.inject({ method: "GET", url: "/api/videos?sort=upload_date&order=desc" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { videos: { youtube_video_id: string; upload_date: string | null }[] };
  assert.equal(body.videos[0].youtube_video_id, "b");
  assert.equal(body.videos[0].upload_date, "2024-06-01");
  await app.close();
  tc.cleanup();
});

// ── DELETE /api/videos/:id (#110) ──────────────────────────────────

test("DELETE /api/videos/:id removes the row; 404 when missing; 400 on bad id", async () => {
  const tc = makeCtx();
  const { channelA } = seed(tc.ctx);
  const v = insertVideo(tc.ctx.db, {
    youtube_video_id: "del1",
    channel_id: channelA,
    title: "to-delete",
    status: "UPLOADED",
  });
  const app = buildServer(tc.ctx);

  const bad = await app.inject({ method: "DELETE", url: "/api/videos/abc" });
  assert.equal(bad.statusCode, 400);

  const miss = await app.inject({ method: "DELETE", url: "/api/videos/99999" });
  assert.equal(miss.statusCode, 404);

  const ok = await app.inject({ method: "DELETE", url: `/api/videos/${v.id}` });
  assert.equal(ok.statusCode, 200);
  const body = ok.json() as { status: string; cancelled: boolean; peertube_deleted: boolean | null };
  assert.equal(body.status, "deleted");
  assert.equal(body.cancelled, false);
  assert.equal(body.peertube_deleted, null);

  const after = await app.inject({ method: "GET", url: `/api/videos/${v.id}` });
  assert.equal(after.statusCode, 404);

  await app.close();
  tc.cleanup();
});

test("DELETE /api/videos/:id?from_peertube=true returns 502 on PT 500", async () => {
  const tc = makeCtx();
  const { channelA } = seed(tc.ctx);
  const v = insertVideo(tc.ctx.db, {
    youtube_video_id: "del2",
    channel_id: channelA,
    title: "uploaded",
    status: "UPLOADED",
  });
  updateVideo(tc.ctx.db, v.id, { peertube_video_uuid: "uuid-abc" });

  // Stub PeertubeConnection with an authFetch that returns 500.
  tc.ctx.peertube = {
    authFetch: async () => new Response("boom", { status: 500 }),
    getStatus: () => ({ online: true, authenticated: true, instance_url: "x", username: "u" }),
  } as unknown as import("../peertube/connection").PeertubeConnection;

  const app = buildServer(tc.ctx);
  const res = await app.inject({
    method: "DELETE",
    url: `/api/videos/${v.id}?from_peertube=true`,
  });
  assert.equal(res.statusCode, 502);

  // Row must remain since PT delete failed.
  const after = await app.inject({ method: "GET", url: `/api/videos/${v.id}` });
  assert.equal(after.statusCode, 200);

  await app.close();
  tc.cleanup();
});

test("DELETE /api/videos/:id?from_peertube=true swallows PT 404", async () => {
  const tc = makeCtx();
  const { channelA } = seed(tc.ctx);
  const v = insertVideo(tc.ctx.db, {
    youtube_video_id: "del3",
    channel_id: channelA,
    title: "gone-on-pt",
    status: "UPLOADED",
  });
  updateVideo(tc.ctx.db, v.id, { peertube_video_uuid: "uuid-gone" });

  tc.ctx.peertube = {
    authFetch: async () => new Response("not found", { status: 404 }),
    getStatus: () => ({ online: true, authenticated: true, instance_url: "x", username: "u" }),
  } as unknown as import("../peertube/connection").PeertubeConnection;

  const app = buildServer(tc.ctx);
  const res = await app.inject({
    method: "DELETE",
    url: `/api/videos/${v.id}?from_peertube=true`,
  });
  assert.equal(res.statusCode, 200);

  const after = await app.inject({ method: "GET", url: `/api/videos/${v.id}` });
  assert.equal(after.statusCode, 404);

  await app.close();
  tc.cleanup();
});

test("DELETE /api/channels/:id cascades through per-video delete", async () => {
  const tc = makeCtx();
  const { channelA } = seed(tc.ctx);
  // channelA starts with 2 videos from seed()
  const app = buildServer(tc.ctx);
  const res = await app.inject({ method: "DELETE", url: `/api/channels/${channelA}` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { videos_deleted: number; status: string };
  assert.equal(body.videos_deleted, 2);
  assert.equal(body.status, "deleted");

  const after = await app.inject({ method: "GET", url: "/api/videos?channel=" + channelA });
  const list = after.json() as { videos: unknown[] };
  assert.equal(list.videos.length, 0);

  await app.close();
  tc.cleanup();
});
