import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { runMigrations, VIDEO_STATUS } from "./schema";
import { insertChannel, getChannelByUrl, listChannels, updateChannelLastSynced } from "./channels";
import {
  insertVideo,
  getVideoByYoutubeId,
  listVideosByStatus,
  listVideosByChannel,
  updateVideo,
  deleteVideo,
} from "./videos";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

test("migrations are idempotent", () => {
  const db = freshDb();
  // running a second time must not throw or duplicate schema_version rows
  runMigrations(db);
  const rows = db.prepare("SELECT COUNT(*) as n FROM schema_version").get() as { n: number };
  assert.equal(rows.n, 2);
});

test("channels DAL: insert, lookup, list, update", () => {
  const db = freshDb();

  const ch = insertChannel(db, {
    youtube_channel_url: "https://www.youtube.com/@example",
    youtube_channel_name: "Example",
    peertube_channel_id: "5",
  });
  assert.equal(ch.youtube_channel_name, "Example");
  assert.equal(ch.last_synced_at, null);

  const found = getChannelByUrl(db, "https://www.youtube.com/@example");
  assert.equal(found?.id, ch.id);

  assert.equal(listChannels(db).length, 1);

  updateChannelLastSynced(db, ch.id, "2026-04-17T00:00:00.000Z");
  const updated = getChannelByUrl(db, "https://www.youtube.com/@example");
  assert.equal(updated?.last_synced_at, "2026-04-17T00:00:00.000Z");
});

test("videos DAL: insert, status transitions, progress, listing", () => {
  const db = freshDb();

  const ch = insertChannel(db, {
    youtube_channel_url: "https://www.youtube.com/@example",
    peertube_channel_id: "5",
  });

  const v = insertVideo(db, {
    youtube_video_id: "abc123",
    channel_id: ch.id,
    title: "Hello",
    status: "DOWNLOAD_QUEUED",
  });
  assert.equal(v.progress_pct, 0);
  assert.equal(v.status, "DOWNLOAD_QUEUED");

  updateVideo(db, v.id, { status: "DOWNLOADING", progress_pct: 42 });
  const mid = getVideoByYoutubeId(db, "abc123")!;
  assert.equal(mid.status, "DOWNLOADING");
  assert.equal(mid.progress_pct, 42);

  updateVideo(db, v.id, { status: "UPLOADED", progress_pct: 100 });
  assert.equal(listVideosByStatus(db, "UPLOADED").length, 1);
  assert.equal(listVideosByStatus(db, "DOWNLOAD_QUEUED").length, 0);
  assert.equal(listVideosByChannel(db, ch.id).length, 1);
});

test("unique constraint on youtube_video_id", () => {
  const db = freshDb();
  const ch = insertChannel(db, {
    youtube_channel_url: "https://www.youtube.com/@ex",
    peertube_channel_id: "5",
  });
  insertVideo(db, { youtube_video_id: "dup", channel_id: ch.id, status: "DOWNLOAD_QUEUED" });
  assert.throws(() =>
    insertVideo(db, { youtube_video_id: "dup", channel_id: ch.id, status: "DOWNLOAD_QUEUED" })
  );
});

test("delete channel cascades to videos", () => {
  const db = freshDb();
  const ch = insertChannel(db, {
    youtube_channel_url: "https://www.youtube.com/@ex",
    peertube_channel_id: "5",
  });
  insertVideo(db, { youtube_video_id: "v1", channel_id: ch.id, status: "DOWNLOAD_QUEUED" });
  insertVideo(db, { youtube_video_id: "v2", channel_id: ch.id, status: "UPLOADED" });
  db.prepare("DELETE FROM channels WHERE id = ?").run(ch.id);
  assert.equal(listVideosByChannel(db, ch.id).length, 0);
});

test("delete video", () => {
  const db = freshDb();
  const ch = insertChannel(db, {
    youtube_channel_url: "https://www.youtube.com/@ex",
    peertube_channel_id: "5",
  });
  const v = insertVideo(db, { youtube_video_id: "v1", channel_id: ch.id, status: "DOWNLOAD_QUEUED" });
  deleteVideo(db, v.id);
  assert.equal(getVideoByYoutubeId(db, "v1"), null);
});

test("VIDEO_STATUS contains all expected states", () => {
  assert.ok(VIDEO_STATUS.includes("UPLOADED"));
  assert.ok(VIDEO_STATUS.includes("DOWNLOAD_FAILED"));
  assert.equal(VIDEO_STATUS.length, 10);
});
