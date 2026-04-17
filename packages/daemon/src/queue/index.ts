import type { Database } from "better-sqlite3";
import type { Config, Logger } from "@yt2pt/shared";
import type { Video } from "../db/videos";
import { getVideoById } from "../db/videos";
import { WorkerPool, type JobProcessor } from "./pool";
import { QueueEvents } from "./events";
import {
  claimNextJob,
  markJobFailed,
  markJobSucceeded,
  resetStaleJobs,
  STAGES,
  type Stage,
} from "./transitions";

export interface JobQueueProcessors {
  download: JobProcessor;
  convert: JobProcessor;
  upload: JobProcessor;
}

export interface JobQueueOptions {
  db: Database;
  config: Config;
  logger: Logger;
  processors: JobQueueProcessors;
}

/**
 * Orchestrates three worker pools (download / convert / upload) backed by
 * the `videos` table. Workers are signaled when a new job is enqueued or
 * when one stage promotes a video to the next stage's queue.
 */
export class JobQueue {
  readonly events = new QueueEvents();
  private pools: Record<Stage, WorkerPool>;
  private started = false;

  constructor(private opts: JobQueueOptions) {
    const { db, config, logger, processors } = opts;

    const makePool = (stage: Stage, processor: JobProcessor): WorkerPool =>
      new WorkerPool({
        name: stage,
        concurrency: Math.max(1, concurrencyFor(stage, config)),
        claim: () => claimOnClaim(db, stage, this.events),
        process: processor,
        onSuccess: (video) => this.handleSuccess(stage, video),
        onFailure: (video, error) => this.handleFailure(stage, video, error),
        logger,
      });

    this.pools = {
      download: makePool("download", processors.download),
      convert: makePool("convert", processors.convert),
      upload: makePool("upload", processors.upload),
    };
  }

  /** Reset stale in-progress jobs and start all pools. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const reset = resetStaleJobs(this.opts.db);
    if (reset > 0) {
      this.opts.logger.info(`Reset ${reset} stale in-progress job(s) to queued on startup`);
    }
    for (const pool of Object.values(this.pools)) pool.start();
    // Kick pools in case there are already queued jobs.
    this.signalAll();
  }

  /** Wake workers for a specific stage (call after inserting new queued items). */
  signal(stage: Stage): void {
    this.pools[stage].signal();
  }

  /** Wake all stages. Useful on startup or when status is changed externally. */
  signalAll(): void {
    for (const pool of Object.values(this.pools)) pool.signal();
  }

  /**
   * Called from the API when a new video has been inserted with a download-
   * queued status.
   */
  notifyNewJob(): void {
    this.signal("download");
  }

  /** Graceful shutdown — finish current jobs, do not pick new ones. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await Promise.allSettled(Object.values(this.pools).map((p) => p.stop()));
  }

  /** Update progress on a running job and emit an event. */
  reportProgress(videoId: number, pct: number): void {
    const bounded = Math.max(0, Math.min(100, Math.round(pct)));
    const now = new Date().toISOString();
    this.opts.db
      .prepare("UPDATE videos SET progress_pct = ?, updated_at = ? WHERE id = ?")
      .run(bounded, now, videoId);
    const video = getVideoById(this.opts.db, videoId);
    if (video) this.events.emit("progress", video);
  }

  private handleSuccess(stage: Stage, video: Video): void {
    markJobSucceeded(this.opts.db, video.id, stage);
    const updated = getVideoById(this.opts.db, video.id);
    if (updated) this.events.emit("status-change", updated);

    // Kick the next stage if there is one.
    if (stage === "download") this.signal("convert");
    else if (stage === "convert") this.signal("upload");
  }

  private handleFailure(stage: Stage, video: Video, error: Error): void {
    this.opts.logger.error(`[${stage}] video ${video.id} failed: ${error.message}`);
    markJobFailed(this.opts.db, video.id, stage, error.message);
    const updated = getVideoById(this.opts.db, video.id);
    if (updated) this.events.emit("status-change", updated);
  }
}

function concurrencyFor(stage: Stage, config: Config): number {
  switch (stage) {
    case "download": return config.workers.download_concurrency;
    case "convert":  return config.workers.convert_concurrency;
    case "upload":   return config.workers.upload_concurrency;
  }
}

function claimOnClaim(db: Database, stage: Stage, events: QueueEvents): Video | null {
  const video = claimNextJob(db, stage);
  if (video) events.emit("status-change", video);
  return video;
}

export { STAGES };
export type { Stage };
