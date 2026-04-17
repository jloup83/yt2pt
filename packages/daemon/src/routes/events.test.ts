import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "../db/schema";
import { buildServer, type ServerContext } from "../server";
import { QueueEvents } from "../queue/events";
import { formatSseFrame, videoToStatusEvent } from "./events";
import type { Video } from "../db/videos";
import type { JobQueue } from "../queue";
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

function makeVideo(id: number): Video {
  return {
    id,
    youtube_video_id: `yt${id}`,
    channel_id: 1,
    title: `v${id}`,
    status: "UPLOADING",
    progress_pct: 42,
    error_message: null,
    folder_name: null,
    created_at: "2026-04-17T00:00:00.000Z",
    updated_at: "2026-04-17T00:00:01.000Z",
  };
}

function makeCtx(queue?: JobQueue): { ctx: ServerContext; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "yt2pt-events-"));
  writeFileSync(join(dir, "yt2pt.conf.toml"), "", "utf-8");
  const db = new Database(":memory:");
  runMigrations(db);
  const logger = { error: () => {}, info: () => {}, debug: () => {} } as unknown as Logger;
  const paths: ResolvedPaths = {
    mode: "dev", configPath: join(dir, "yt2pt.conf.toml"),
    dataDir: dir, logDir: dir, binDir: dir,
  };
  return {
    ctx: { config: makeConfig(), paths, db, logger, queue },
    cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("formatSseFrame() produces the expected event/data framing", () => {
  const frame = formatSseFrame("video_status", { id: 1, status: "UPLOADED" });
  assert.equal(frame, 'event: video_status\ndata: {"id":1,"status":"UPLOADED"}\n\n');
});

test("videoToStatusEvent() keeps only the fields the UI needs", () => {
  const ev = videoToStatusEvent(makeVideo(7));
  assert.deepEqual(ev, {
    id: 7,
    status: "UPLOADING",
    progress_pct: 42,
    updated_at: "2026-04-17T00:00:01.000Z",
    error_message: null,
  });
});

test("GET /api/events streams the initial hello and queue status-change events", async () => {
  // Construct a fake queue exposing only `.events` — the SSE route does not
  // touch anything else on the queue.
  const events = new QueueEvents();
  const fakeQueue = { events } as unknown as JobQueue;
  const { ctx, cleanup } = makeCtx(fakeQueue);
  try {
    const app = buildServer(ctx);
    await app.ready();
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    const res = await fetch(`${address}/api/events`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const read = async (predicate: (s: string) => boolean, timeoutMs = 2_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(buffer)) return;
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      throw new Error(`timeout waiting for frame; buffer=${buffer}`);
    };

    await read((s) => s.includes("event: hello"));
    // Emit a status-change — SSE should forward it.
    setImmediate(() => events.emit("status-change", makeVideo(9)));
    await read((s) => s.includes("event: video_status") && s.includes('"id":9'));

    await reader.cancel();
    await app.close();
  } finally {
    cleanup();
  }
});

test("GET /api/events works without queue or peertube wired", async () => {
  const { ctx, cleanup } = makeCtx();
  try {
    const app = buildServer(ctx);
    await app.ready();
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const res = await fetch(`${address}/api/events`);
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    assert.match(chunk, /event: hello/);
    await reader.cancel();
    await app.close();
  } finally {
    cleanup();
  }
});
