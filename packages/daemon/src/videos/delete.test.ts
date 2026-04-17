import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "../db/schema";
import { insertChannel } from "../db/channels";
import { insertVideo, updateVideo, getVideoById } from "../db/videos";
import {
  deleteVideoOrchestrator,
  deletePeertubeVideo,
  PeertubeDeleteError,
  deleteLocalVideoFiles,
} from "./delete";
import type { Logger, ResolvedPaths } from "@yt2pt/shared";

const silentLogger: Logger = {
  error: () => {},
  info: () => {},
  debug: () => {},
  warn: () => {},
} as unknown as Logger;

function makeCtx(): {
  db: Database.Database;
  paths: ResolvedPaths;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "yt2pt-delete-"));
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const paths: ResolvedPaths = {
    mode: "dev",
    configPath: join(dir, "yt2pt.conf.toml"),
    dataDir: dir,
    logDir: dir,
    binDir: dir,
  };
  return { db, paths, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("deleteLocalVideoFiles() removes both downloaded and converted folders", async () => {
  const { db, paths, cleanup } = makeCtx();
  const slug = "alpha";
  const folder = `${slug}_2024-06-01_hello`;
  const d1 = join(paths.dataDir, "downloaded_from_youtube", slug, folder);
  const d2 = join(paths.dataDir, "upload_to_peertube", slug, folder);
  mkdirSync(d1, { recursive: true });
  mkdirSync(d2, { recursive: true });
  writeFileSync(join(d1, "video.mp4"), "x");
  writeFileSync(join(d2, "video.mkv"), "y");

  const ch = insertChannel(db, {
    youtube_channel_url: "https://www.youtube.com/@a",
    peertube_channel_id: "1",
  });
  const v = insertVideo(db, {
    youtube_video_id: "vid",
    channel_id: ch.id,
    status: "UPLOADED",
    folder_name: folder,
  });
  const video = getVideoById(db, v.id)!;

  await deleteLocalVideoFiles(paths, video, silentLogger);
  assert.equal(existsSync(d1), false);
  assert.equal(existsSync(d2), false);

  // Idempotent: calling again does not throw.
  await deleteLocalVideoFiles(paths, video, silentLogger);
  cleanup();
});

test("deletePeertubeVideo() treats 404 as success, 500 as error", async () => {
  const ok = {
    authFetch: async () => new Response(null, { status: 204 }),
  } as unknown as import("../peertube/connection").PeertubeConnection;
  await deletePeertubeVideo(ok, "uuid");

  const gone = {
    authFetch: async () => new Response("nope", { status: 404 }),
  } as unknown as import("../peertube/connection").PeertubeConnection;
  await deletePeertubeVideo(gone, "uuid");

  const boom = {
    authFetch: async () => new Response("boom", { status: 500 }),
  } as unknown as import("../peertube/connection").PeertubeConnection;
  await assert.rejects(() => deletePeertubeVideo(boom, "uuid"), PeertubeDeleteError);
});

test("deleteVideoOrchestrator() skips PT when fromPeertube is false", async () => {
  const { db, paths, cleanup } = makeCtx();
  const ch = insertChannel(db, {
    youtube_channel_url: "https://www.youtube.com/@a",
    peertube_channel_id: "1",
  });
  const v = insertVideo(db, { youtube_video_id: "v", channel_id: ch.id, status: "UPLOADED" });
  updateVideo(db, v.id, { peertube_video_uuid: "should-not-matter" });
  const video = getVideoById(db, v.id)!;

  let called = false;
  const peertube = {
    authFetch: async () => {
      called = true;
      return new Response(null, { status: 204 });
    },
  } as unknown as import("../peertube/connection").PeertubeConnection;

  const res = await deleteVideoOrchestrator(
    { db, paths, logger: silentLogger, peertube },
    video,
    { fromPeertube: false },
  );
  assert.equal(res.peertube_deleted, null);
  assert.equal(called, false);
  assert.equal(getVideoById(db, v.id), null);
  cleanup();
});

test("deleteVideoOrchestrator() warns when fromPeertube requested but no uuid", async () => {
  const { db, paths, cleanup } = makeCtx();
  const ch = insertChannel(db, {
    youtube_channel_url: "https://www.youtube.com/@a",
    peertube_channel_id: "1",
  });
  const v = insertVideo(db, { youtube_video_id: "v", channel_id: ch.id, status: "UPLOADED" });
  const video = getVideoById(db, v.id)!;

  const peertube = {
    authFetch: async () => new Response(null, { status: 204 }),
  } as unknown as import("../peertube/connection").PeertubeConnection;

  const res = await deleteVideoOrchestrator(
    { db, paths, logger: silentLogger, peertube },
    video,
    { fromPeertube: true },
  );
  assert.equal(res.peertube_deleted, null);
  assert.ok(res.warnings.some((w) => w.includes("no peertube uuid")));
  assert.equal(getVideoById(db, v.id), null);
  cleanup();
});
