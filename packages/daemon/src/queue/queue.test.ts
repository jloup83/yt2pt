import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { Config, Logger } from "@yt2pt/shared";
import { runMigrations } from "../db/schema";
import { insertChannel } from "../db/channels";
import { insertVideo, getVideoById, listVideosByStatus } from "../db/videos";
import { JobQueue } from "./index";
import { claimNextJob, markJobSucceeded, markJobFailed, resetStaleJobs } from "./transitions";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function silentLogger(): Logger {
  return { error: () => {}, info: () => {}, debug: () => {} } as unknown as Logger;
}

function testConfig(overrides: Partial<Config["workers"]> = {}): Config {
  return {
    yt2pt: { data_dir: "/tmp", log_dir: "/tmp", log_level: "error" },
    http: { port: 0, bind: "127.0.0.1" },
    workers: { download_concurrency: 1, convert_concurrency: 1, upload_concurrency: 1, ...overrides },
    ytdlp: { format: "", merge_output_format: "", thumbnail_format: "" },
    peertube: {
      instance_url: "", api_token: "", channel_id: "", privacy: "public",
      language: "", licence: "", comments_policy: "enabled",
      wait_transcoding: false, generate_transcription: false,
    },
  } as unknown as Config;
}

function seedVideos(db: Database.Database, statuses: string[]) {
  const ch = insertChannel(db, {
    youtube_channel_url: "https://www.youtube.com/@x",
    peertube_channel_id: "1",
  });
  return statuses.map((status, i) =>
    insertVideo(db, {
      youtube_video_id: `v${i}`,
      channel_id: ch.id,
      title: `Video ${i}`,
      status: status as never,
    })
  );
}

// ── Transitions ─────────────────────────────────────────────────────

test("claimNextJob returns oldest queued and marks it active", () => {
  const db = freshDb();
  seedVideos(db, ["DOWNLOAD_QUEUED", "DOWNLOAD_QUEUED"]);
  const claimed = claimNextJob(db, "download");
  assert.ok(claimed);
  assert.equal(claimed!.status, "DOWNLOADING");
  assert.equal(claimed!.youtube_video_id, "v0");
  const next = claimNextJob(db, "download");
  assert.equal(next!.youtube_video_id, "v1");
  assert.equal(claimNextJob(db, "download"), null);
});

test("markJobSucceeded transitions to next stage", () => {
  const db = freshDb();
  const [v] = seedVideos(db, ["DOWNLOAD_QUEUED"]);
  claimNextJob(db, "download");
  markJobSucceeded(db, v.id, "download");
  assert.equal(getVideoById(db, v.id)!.status, "CONVERT_QUEUED");
  markJobSucceeded(db, v.id, "convert");
  // we need to first mark active again to simulate real flow, but transitions
  // don't require it — they just set status.
  markJobSucceeded(db, v.id, "upload");
  assert.equal(getVideoById(db, v.id)!.status, "UPLOADED");
  assert.equal(getVideoById(db, v.id)!.progress_pct, 100);
});

test("markJobFailed stores error and moves to *_FAILED", () => {
  const db = freshDb();
  const [v] = seedVideos(db, ["DOWNLOAD_QUEUED"]);
  markJobFailed(db, v.id, "download", "network error");
  const updated = getVideoById(db, v.id)!;
  assert.equal(updated.status, "DOWNLOAD_FAILED");
  assert.equal(updated.error_message, "network error");
});

test("resetStaleJobs moves all *ING back to *_QUEUED", () => {
  const db = freshDb();
  seedVideos(db, ["DOWNLOADING", "CONVERTING", "UPLOADING", "DOWNLOAD_QUEUED", "UPLOADED"]);
  const n = resetStaleJobs(db);
  assert.equal(n, 3);
  assert.equal(listVideosByStatus(db, "DOWNLOAD_QUEUED").length, 2);
  assert.equal(listVideosByStatus(db, "CONVERT_QUEUED").length, 1);
  assert.equal(listVideosByStatus(db, "UPLOAD_QUEUED").length, 1);
  assert.equal(listVideosByStatus(db, "UPLOADED").length, 1);
});

// ── JobQueue end-to-end ─────────────────────────────────────────────

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

test("JobQueue: happy path runs video through all 3 stages", async () => {
  const db = freshDb();
  const [v] = seedVideos(db, ["DOWNLOAD_QUEUED"]);

  const processed: Record<string, number[]> = { download: [], convert: [], upload: [] };
  const q = new JobQueue({
    db,
    config: testConfig(),
    logger: silentLogger(),
    processors: {
      download: async (video) => { processed.download.push(video.id); },
      convert:  async (video) => { processed.convert.push(video.id); },
      upload:   async (video) => { processed.upload.push(video.id); },
    },
  });

  const statusChanges: string[] = [];
  q.events.on("status-change", (video) => statusChanges.push(video.status));

  q.start();
  // Wait until upload completes.
  for (let i = 0; i < 100; i++) {
    if (getVideoById(db, v.id)!.status === "UPLOADED") break;
    await delay(10);
  }
  await q.stop();

  assert.equal(getVideoById(db, v.id)!.status, "UPLOADED");
  assert.equal(getVideoById(db, v.id)!.progress_pct, 100);
  assert.deepEqual(processed.download, [v.id]);
  assert.deepEqual(processed.convert, [v.id]);
  assert.deepEqual(processed.upload, [v.id]);

  // Every stage emits at least: *ING (claim) and next status (success)
  assert.ok(statusChanges.includes("DOWNLOADING"));
  assert.ok(statusChanges.includes("CONVERT_QUEUED"));
  assert.ok(statusChanges.includes("UPLOADED"));
});

test("JobQueue: failure in download moves to DOWNLOAD_FAILED and stops", async () => {
  const db = freshDb();
  const [v] = seedVideos(db, ["DOWNLOAD_QUEUED"]);

  const q = new JobQueue({
    db,
    config: testConfig(),
    logger: silentLogger(),
    processors: {
      download: async () => { throw new Error("boom"); },
      convert:  async () => { throw new Error("should not run"); },
      upload:   async () => { throw new Error("should not run"); },
    },
  });

  q.start();
  for (let i = 0; i < 50; i++) {
    if (getVideoById(db, v.id)!.status === "DOWNLOAD_FAILED") break;
    await delay(10);
  }
  await q.stop();

  const final = getVideoById(db, v.id)!;
  assert.equal(final.status, "DOWNLOAD_FAILED");
  assert.equal(final.error_message, "boom");
});

test("JobQueue: concurrency > 1 processes multiple videos in parallel", async () => {
  const db = freshDb();
  const videos = seedVideos(db, ["DOWNLOAD_QUEUED", "DOWNLOAD_QUEUED", "DOWNLOAD_QUEUED"]);

  let active = 0;
  let peak = 0;
  const q = new JobQueue({
    db,
    config: testConfig({ download_concurrency: 3 }),
    logger: silentLogger(),
    processors: {
      download: async () => {
        active++;
        peak = Math.max(peak, active);
        await delay(30);
        active--;
      },
      convert: async () => {},
      upload:  async () => {},
    },
  });

  q.start();
  for (let i = 0; i < 100; i++) {
    const allDone = videos.every((v) => getVideoById(db, v.id)!.status === "UPLOADED");
    if (allDone) break;
    await delay(10);
  }
  await q.stop();

  assert.equal(peak, 3, `expected peak concurrency 3, got ${peak}`);
});

test("JobQueue: notifyNewJob wakes idle download workers", async () => {
  const db = freshDb();
  const ch = insertChannel(db, {
    youtube_channel_url: "https://www.youtube.com/@x",
    peertube_channel_id: "1",
  });

  let processed = 0;
  const q = new JobQueue({
    db,
    config: testConfig(),
    logger: silentLogger(),
    processors: {
      download: async () => { processed++; },
      convert:  async () => {},
      upload:   async () => {},
    },
  });

  q.start();
  await delay(20); // workers park (nothing in queue)

  const v = insertVideo(db, {
    youtube_video_id: "late",
    channel_id: ch.id,
    status: "DOWNLOAD_QUEUED",
  });
  q.notifyNewJob();

  for (let i = 0; i < 50; i++) {
    if (getVideoById(db, v.id)!.status === "UPLOADED") break;
    await delay(10);
  }
  await q.stop();

  assert.equal(processed, 1);
  assert.equal(getVideoById(db, v.id)!.status, "UPLOADED");
});

test("JobQueue: stop aborts in-flight job via signal", async () => {
  const db = freshDb();
  const [v] = seedVideos(db, ["DOWNLOAD_QUEUED"]);

  let abortSeen = false;
  const q = new JobQueue({
    db,
    config: testConfig(),
    logger: silentLogger(),
    processors: {
      download: async (_video, signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            abortSeen = true;
            resolve();
          });
          setTimeout(resolve, 500);
        });
        // Throw after abort so we hit the abort branch in the pool.
        if (signal.aborted) throw new Error("aborted");
      },
      convert: async () => {},
      upload: async () => {},
    },
  });

  q.start();
  await delay(30); // let the worker claim the job
  assert.equal(getVideoById(db, v.id)!.status, "DOWNLOADING");
  await q.stop();

  assert.ok(abortSeen, "abort signal should fire during shutdown");
  // Status is left as DOWNLOADING; startup reset would requeue it.
  assert.equal(getVideoById(db, v.id)!.status, "DOWNLOADING");
});
