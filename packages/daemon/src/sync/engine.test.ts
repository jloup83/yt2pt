import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import Database from "better-sqlite3";
import { runMigrations } from "../db/schema";
import { insertChannel, getChannelById } from "../db/channels";
import { insertVideo, listVideosByChannel } from "../db/videos";
import { SyncEngine, type YtdlpSpawner } from "./engine";
import type { Logger } from "@yt2pt/shared";

function silentLogger(): Logger {
  return { error: () => {}, info: () => {}, debug: () => {}, warn: () => {} } as unknown as Logger;
}

/**
 * Build a fake yt-dlp spawner that emits each given line as a stdout
 * frame and then exits with `exitCode`. Optional `stderr` lines are
 * written to stderr.
 */
function fakeSpawner(lines: string[], opts: { exitCode?: number; stderr?: string[]; delayMs?: number } = {}): {
  spawner: YtdlpSpawner;
  killed: () => boolean;
} {
  let killedFlag = false;
  const spawner: YtdlpSpawner = () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const ee = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
    Object.assign(ee, {
      stdout,
      stderr,
      stdin: new PassThrough(),
      pid: 1234,
      exitCode: null as number | null,
      kill(_signal?: NodeJS.Signals | number): boolean {
        killedFlag = true;
        stdout.end();
        stderr.end();
        (ee as { exitCode: number }).exitCode = 143;
        setImmediate(() => ee.emit("exit", 143, "SIGTERM"));
        return true;
      },
    });

    const emit = async (): Promise<void> => {
      for (const line of lines) {
        stdout.write(line + "\n");
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      for (const line of opts.stderr ?? []) stderr.write(line + "\n");
      stdout.end();
      stderr.end();
      const code = opts.exitCode ?? 0;
      (ee as { exitCode: number }).exitCode = code;
      setImmediate(() => ee.emit("exit", code, null));
    };
    // Allow readline to subscribe before the stream drains.
    setImmediate(() => { void emit(); });

    return ee;
  };
  return { spawner, killed: () => killedFlag };
}

function waitEvent<T = unknown>(engine: SyncEngine, name: "sync-started" | "sync-progress" | "sync-completed" | "sync-failed"): Promise<T> {
  return once(engine as unknown as EventEmitter, name).then((args) => args[0] as T);
}

function makeCtx(): { db: Database.Database; cleanup: () => void } {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return { db, cleanup: () => db.close() };
}

// ── Tests ───────────────────────────────────────────────────────────

test("SyncEngine inserts new videos as DOWNLOAD_QUEUED and counts already-tracked", async () => {
  const { db, cleanup } = makeCtx();
  const channel = insertChannel(db, {
    youtube_channel_url: "https://www.youtube.com/@chan",
    peertube_channel_id: "5",
  });
  // Pre-insert one existing video to exercise the already-tracked path.
  insertVideo(db, {
    youtube_video_id: "EXISTING1",
    channel_id: channel.id,
    status: "UPLOADED",
  });

  const { spawner } = fakeSpawner([
    JSON.stringify({ id: "NEWVID001", title: "First" }),
    JSON.stringify({ id: "EXISTING1", title: "Already" }),
    JSON.stringify({ id: "NEWVID002", title: "Second" }),
  ]);

  const engine = new SyncEngine({
    db, logger: silentLogger(), ytdlpBinary: "/fake", spawner,
  });
  const completed = waitEvent<{ new_videos: number; already_tracked: number; channel_id: number }>(engine, "sync-completed");
  const result = engine.trigger(channel.id);
  assert.equal(result.status, "started");
  const ev = await completed;

  assert.equal(ev.new_videos, 2);
  assert.equal(ev.already_tracked, 1);
  assert.equal(ev.channel_id, channel.id);

  const rows = listVideosByChannel(db, channel.id);
  assert.equal(rows.length, 3);
  const queued = rows.filter((v) => v.status === "DOWNLOAD_QUEUED");
  assert.equal(queued.length, 2);
  assert.deepEqual(
    new Set(queued.map((v) => v.youtube_video_id)),
    new Set(["NEWVID001", "NEWVID002"])
  );
  // last_synced_at was stamped.
  const after = getChannelById(db, channel.id)!;
  assert.ok(after.last_synced_at);

  cleanup();
});

test("SyncEngine skips private/unavailable entries and malformed JSON", async () => {
  const { db, cleanup } = makeCtx();
  const channel = insertChannel(db, {
    youtube_channel_url: "https://www.youtube.com/@chan", peertube_channel_id: "5",
  });

  const { spawner } = fakeSpawner([
    JSON.stringify({ id: "PUBOK0001", title: "Public" }),
    JSON.stringify({ id: "PRIV00001", title: "Private", availability: "private" }),
    "not json at all",
    JSON.stringify({ title: "no id field" }),
    JSON.stringify({ id: "UNLIST001", title: "Unlisted", availability: "unlisted" }),
  ]);

  const engine = new SyncEngine({ db, logger: silentLogger(), ytdlpBinary: "/fake", spawner });
  const completed = waitEvent<{ new_videos: number; skipped: number; already_tracked: number }>(engine, "sync-completed");
  engine.trigger(channel.id);
  const ev = await completed;

  // 2 inserted (public + unlisted), 3 skipped, 0 already tracked.
  assert.equal(ev.new_videos, 2);
  assert.equal(ev.already_tracked, 0);
  assert.equal(ev.skipped, 3);

  cleanup();
});

test("SyncEngine rejects concurrent triggers for the same channel", async () => {
  const { db, cleanup } = makeCtx();
  const channel = insertChannel(db, {
    youtube_channel_url: "https://www.youtube.com/@chan", peertube_channel_id: "5",
  });
  // Give the first sync time to start by using a small delay between lines.
  const { spawner } = fakeSpawner(
    [
      JSON.stringify({ id: "V000001A", title: "A" }),
      JSON.stringify({ id: "V000002B", title: "B" }),
    ],
    { delayMs: 25 }
  );

  const engine = new SyncEngine({ db, logger: silentLogger(), ytdlpBinary: "/fake", spawner });
  const first = engine.trigger(channel.id);
  assert.equal(first.status, "started");
  const second = engine.trigger(channel.id);
  assert.equal(second.status, "in_progress");

  await waitEvent(engine, "sync-completed");
  cleanup();
});

test("SyncEngine rate-limits syncs within the configured window", async () => {
  const { db, cleanup } = makeCtx();
  const channel = insertChannel(db, {
    youtube_channel_url: "https://www.youtube.com/@chan", peertube_channel_id: "5",
  });

  const { spawner } = fakeSpawner([JSON.stringify({ id: "ONE00001", title: "One" })]);
  const engine = new SyncEngine({
    db, logger: silentLogger(), ytdlpBinary: "/fake", spawner,
    rateLimitSeconds: 60,
  });

  const firstDone = waitEvent(engine, "sync-completed");
  engine.trigger(channel.id);
  await firstDone;

  // Second immediate call should be rate-limited.
  const again = engine.trigger(channel.id);
  assert.equal(again.status, "rate_limited");
  if (again.status === "rate_limited") {
    assert.ok(again.retry_after_s > 0 && again.retry_after_s <= 60);
  }

  cleanup();
});

test("SyncEngine emits sync-failed when yt-dlp exits non-zero with no entries", async () => {
  const { db, cleanup } = makeCtx();
  const channel = insertChannel(db, {
    youtube_channel_url: "https://www.youtube.com/@chan", peertube_channel_id: "5",
  });

  const { spawner } = fakeSpawner([], { exitCode: 2, stderr: ["ERROR: channel not found"] });
  const engine = new SyncEngine({ db, logger: silentLogger(), ytdlpBinary: "/fake", spawner });

  const failed = waitEvent<{ channel_id: number; error: string }>(engine, "sync-failed");
  engine.trigger(channel.id);
  const ev = await failed;

  assert.equal(ev.channel_id, channel.id);
  assert.match(ev.error, /yt-dlp exited/);
  // last_synced_at should NOT be set on failure.
  const after = getChannelById(db, channel.id)!;
  assert.equal(after.last_synced_at, null);

  cleanup();
});

test("SyncEngine.trigger throws for unknown channel id", () => {
  const { db, cleanup } = makeCtx();
  const { spawner } = fakeSpawner([]);
  const engine = new SyncEngine({ db, logger: silentLogger(), ytdlpBinary: "/fake", spawner });
  assert.throws(() => engine.trigger(9999), /not found/);
  cleanup();
});

test("SyncEngine.cancel aborts an in-progress sync", async () => {
  const { db, cleanup } = makeCtx();
  const channel = insertChannel(db, {
    youtube_channel_url: "https://www.youtube.com/@chan", peertube_channel_id: "5",
  });
  const { spawner, killed } = fakeSpawner(
    Array.from({ length: 50 }, (_, i) => JSON.stringify({ id: `C${String(i).padStart(6, "0")}`, title: "x" })),
    { delayMs: 10 }
  );
  const engine = new SyncEngine({ db, logger: silentLogger(), ytdlpBinary: "/fake", spawner });

  engine.trigger(channel.id);
  // Let one line flow before cancelling.
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(engine.cancel(channel.id), true);

  // Wait for either completion or failure — cancel should surface as completion
  // (stream ends gracefully; exit code 143 with entries seen ≥ 0).
  await Promise.race([
    waitEvent(engine, "sync-completed"),
    waitEvent(engine, "sync-failed"),
  ]);
  assert.equal(killed(), true);
  // After settle, channel should no longer be running.
  assert.equal(engine.isRunning(channel.id), false);
  cleanup();
});
