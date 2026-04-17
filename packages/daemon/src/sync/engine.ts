import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { Database } from "better-sqlite3";
import type { Logger } from "@yt2pt/shared";
import {
  getChannelById,
  updateChannelLastSynced,
  type Channel,
} from "../db/channels";
import { getVideoByYoutubeId, insertVideo } from "../db/videos";
import type { JobQueue } from "../queue";
import { fetchChannelInfo, type FetchChannelInfoOptions } from "./channel-info";

// ── Types ───────────────────────────────────────────────────────────

export interface SyncResult {
  channel_id: number;
  new_videos: number;
  already_tracked: number;
  skipped: number;
}

export interface SyncProgress {
  channel_id: number;
  new_videos: number;
  already_tracked: number;
}

export type TriggerResult =
  | { status: "started"; channel_id: number }
  | { status: "in_progress"; channel_id: number }
  | { status: "rate_limited"; channel_id: number; retry_after_s: number };

export interface SyncEngineEvents {
  "sync-started": [{ channel_id: number; youtube_channel_url: string }];
  "sync-progress": [SyncProgress];
  "sync-completed": [SyncResult];
  "sync-failed": [{ channel_id: number; error: string }];
}

export interface SyncEngineOptions {
  db: Database;
  logger: Logger;
  queue?: JobQueue;
  ytdlpBinary: string | (() => Promise<string>);
  /** Data root (for channel_info/ side effects). Optional in tests. */
  dataDir?: string;
  /** Minimum seconds between two syncs of the same channel. */
  rateLimitSeconds?: number;
  /** Override yt-dlp spawner (tests). */
  spawner?: YtdlpSpawner;
  /** Override channel-info fetcher (tests). */
  fetchChannelInfo?: (opts: FetchChannelInfoOptions) => Promise<unknown>;
  /** Progress reporting cadence (entries processed). */
  progressEvery?: number;
}

export type YtdlpSpawner = (binary: string, args: string[]) => ChildProcessWithoutNullStreams;

// ── Engine ──────────────────────────────────────────────────────────

const DEFAULT_RATE_LIMIT_S = 60;
const DEFAULT_PROGRESS_EVERY = 25;

export class SyncEngine extends EventEmitter<SyncEngineEvents> {
  private inProgress = new Set<number>();
  private aborts = new Map<number, AbortController>();
  private readonly rateLimitSeconds: number;
  private readonly progressEvery: number;

  constructor(private readonly opts: SyncEngineOptions) {
    super();
    this.rateLimitSeconds = opts.rateLimitSeconds ?? DEFAULT_RATE_LIMIT_S;
    this.progressEvery = opts.progressEvery ?? DEFAULT_PROGRESS_EVERY;
  }

  /**
   * Kick off a background sync. Returns immediately. Results are emitted
   * via `sync-completed` / `sync-failed` events.
   */
  trigger(channelId: number): TriggerResult {
    if (this.inProgress.has(channelId)) {
      return { status: "in_progress", channel_id: channelId };
    }
    const channel = getChannelById(this.opts.db, channelId);
    if (!channel) {
      // Caller should have validated existence; surface as failure.
      throw new Error(`channel ${channelId} not found`);
    }
    const retryAfter = this.rateLimitRemaining(channel);
    if (retryAfter > 0) {
      return { status: "rate_limited", channel_id: channelId, retry_after_s: retryAfter };
    }

    this.inProgress.add(channelId);
    const abort = new AbortController();
    this.aborts.set(channelId, abort);
    this.emit("sync-started", {
      channel_id: channelId,
      youtube_channel_url: channel.youtube_channel_url,
    });

    void this.runSync(channel, abort.signal)
      .then((result) => {
        updateChannelLastSynced(this.opts.db, channel.id);
        this.emit("sync-completed", result);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.opts.logger.error(`[sync] channel ${channelId} failed: ${msg}`);
        this.emit("sync-failed", { channel_id: channelId, error: msg });
      })
      .finally(() => {
        this.inProgress.delete(channelId);
        this.aborts.delete(channelId);
      });

    return { status: "started", channel_id: channelId };
  }

  /** Abort an in-progress sync. No-op if not running. */
  cancel(channelId: number): boolean {
    const abort = this.aborts.get(channelId);
    if (!abort) return false;
    abort.abort();
    return true;
  }

  /** Stop all in-progress syncs (graceful shutdown). */
  stopAll(): void {
    for (const abort of this.aborts.values()) abort.abort();
  }

  /** Returns true if a sync is currently running for this channel. */
  isRunning(channelId: number): boolean {
    return this.inProgress.has(channelId);
  }

  private rateLimitRemaining(channel: Channel): number {
    if (!channel.last_synced_at) return 0;
    const last = Date.parse(channel.last_synced_at);
    if (Number.isNaN(last)) return 0;
    const elapsed = (Date.now() - last) / 1000;
    const remain = Math.ceil(this.rateLimitSeconds - elapsed);
    return remain > 0 ? remain : 0;
  }

  private async resolveBinary(): Promise<string> {
    return typeof this.opts.ytdlpBinary === "string"
      ? this.opts.ytdlpBinary
      : await this.opts.ytdlpBinary();
  }

  private async runSync(channel: Channel, signal: AbortSignal): Promise<SyncResult> {
    const binary = await this.resolveBinary();

    // Refresh on-disk channel info (avatar, banner, metadata.json).
    // Non-fatal: a failure here should not block video discovery.
    if (this.opts.dataDir) {
      const fetcher = this.opts.fetchChannelInfo ?? fetchChannelInfo;
      try {
        await fetcher({
          ytdlp: binary,
          channelUrl: channel.youtube_channel_url,
          dataDir: this.opts.dataDir,
          logger: this.opts.logger,
          signal,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.opts.logger.error(`[sync] channel info fetch failed for ${channel.id}: ${msg}`);
      }
    }

    const spawner = this.opts.spawner ?? defaultSpawn;
    const child = spawner(binary, [
      "--flat-playlist",
      "--dump-json",
      "--no-warnings",
      "--ignore-errors",
      channel.youtube_channel_url,
    ]);

    let newVideos = 0;
    let alreadyTracked = 0;
    let skipped = 0;

    const onAbort = (): void => {
      try { child.kill("SIGTERM"); } catch { /* noop */ }
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const stderr: string[] = [];
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      // Keep only a short tail for error reporting.
      stderr.push(chunk);
      if (stderr.length > 20) stderr.shift();
    });

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

    try {
      for await (const line of rl) {
        if (signal.aborted) break;
        const trimmed = line.trim();
        if (!trimmed) continue;

        let entry: FlatPlaylistEntry;
        try {
          entry = JSON.parse(trimmed) as FlatPlaylistEntry;
        } catch {
          skipped++;
          continue;
        }
        const youtubeId = entry.id;
        if (!youtubeId || typeof youtubeId !== "string") {
          skipped++;
          continue;
        }
        // Private / unavailable videos get flagged by yt-dlp.
        if (entry.availability && entry.availability !== "public" && entry.availability !== "unlisted") {
          skipped++;
          continue;
        }

        const existing = getVideoByYoutubeId(this.opts.db, youtubeId);
        if (existing) {
          alreadyTracked++;
        } else {
          insertVideo(this.opts.db, {
            youtube_video_id: youtubeId,
            channel_id: channel.id,
            title: entry.title ?? null,
            status: "DOWNLOAD_QUEUED",
            upload_date: normalizeUploadDate(entry),
          });
          newVideos++;
          if (newVideos % this.progressEvery === 0) {
            this.emit("sync-progress", {
              channel_id: channel.id,
              new_videos: newVideos,
              already_tracked: alreadyTracked,
            });
          }
        }
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      rl.close();
    }

    const exitCode = await waitForExit(child);
    // --ignore-errors causes yt-dlp to exit 0 even when skipping entries.
    // Only fail hard if we got a real non-zero exit and produced nothing.
    if (exitCode !== 0 && newVideos === 0 && alreadyTracked === 0) {
      throw new Error(
        `yt-dlp exited with code ${exitCode}: ${stderr.join("").trim().slice(-500) || "no stderr"}`
      );
    }

    if (newVideos > 0) {
      this.opts.queue?.notifyNewJob();
    }

    return {
      channel_id: channel.id,
      new_videos: newVideos,
      already_tracked: alreadyTracked,
      skipped,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

interface FlatPlaylistEntry {
  id?: string;
  title?: string;
  availability?: string;
  url?: string;
  upload_date?: string;
  timestamp?: number;
}

/**
 * Convert an upload timestamp from a yt-dlp flat-playlist entry into
 * a YYYY-MM-DD string. yt-dlp's `upload_date` is already `YYYYMMDD`;
 * `timestamp` is a Unix epoch in seconds. Returns null if unavailable.
 */
function normalizeUploadDate(entry: FlatPlaylistEntry): string | null {
  if (typeof entry.upload_date === "string" && /^\d{8}$/.test(entry.upload_date)) {
    const s = entry.upload_date;
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  if (typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)) {
    const d = new Date(entry.timestamp * 1000);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

function defaultSpawn(binary: string, args: string[]): ChildProcessWithoutNullStreams {
  return spawn(binary, args) as ChildProcessWithoutNullStreams;
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once("exit", (code) => resolve(code ?? 0));
    child.once("error", () => resolve(1));
  });
}
