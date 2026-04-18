import type { Video } from "../db/videos";
import type { Logger } from "@yt2pt/shared";

export type JobProcessor = (video: Video, signal: AbortSignal) => Promise<void>;

export interface WorkerPoolOptions {
  name: string;
  concurrency: number;
  claim: () => Video | null;
  process: JobProcessor;
  onSuccess: (video: Video) => void;
  onFailure: (video: Video, error: Error) => void;
  logger: Logger;
}

/**
 * A signal-driven worker pool.
 *
 * Each worker loops: claim a job → process it → on completion, claim another.
 * When the queue is empty, workers park on a promise that is resolved by
 * `signal()`. `stop()` aborts all in-flight jobs via the abort signal passed
 * to the processor and waits for all workers to exit.
 */
export class WorkerPool {
  private running = false;
  private workers: Promise<void>[] = [];
  private controller = new AbortController();
  private wakers: Array<() => void> = [];
  /**
   * Per-in-flight-job controllers, keyed by video id. Each is linked to
   * the pool-wide controller (shutdown aborts all jobs), but can also be
   * aborted individually by `cancelJob(videoId)` for targeted cancellation
   * (e.g. the delete flow in #110).
   */
  private jobControllers = new Map<number, AbortController>();

  constructor(private opts: WorkerPoolOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.controller = new AbortController();
    for (let i = 0; i < this.opts.concurrency; i++) {
      this.workers.push(this.loop(i));
    }
  }

  /** Wake all idle workers to re-check the queue. */
  signal(): void {
    const wakers = this.wakers;
    this.wakers = [];
    for (const w of wakers) w();
  }

  /**
   * Abort the in-flight job for the given video id, if any. Safe to call
   * when no such job exists (returns `false`).
   */
  cancelJob(videoId: number): boolean {
    const ctrl = this.jobControllers.get(videoId);
    if (!ctrl) return false;
    ctrl.abort();
    return true;
  }

  /** True while this pool holds an in-flight job for the given video. */
  hasJob(videoId: number): boolean {
    return this.jobControllers.has(videoId);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.controller.abort();
    this.signal();
    await Promise.allSettled(this.workers);
    this.workers = [];
  }

  get abortSignal(): AbortSignal {
    return this.controller.signal;
  }

  private async loop(index: number): Promise<void> {
    const { name, claim, process: processJob, onSuccess, onFailure, logger } = this.opts;
    while (this.running) {
      let video: Video | null;
      try {
        video = claim();
      } catch (err) {
        logger.error(`[${name}/${index}] claim failed: ${errorMessage(err)}`);
        await this.park();
        continue;
      }
      if (!video) {
        await this.park();
        continue;
      }
      // Chain a per-job controller so callers can cancel this specific
      // job without shutting the whole pool down.
      const jobCtrl = new AbortController();
      const onPoolAbort = (): void => jobCtrl.abort();
      this.controller.signal.addEventListener("abort", onPoolAbort, { once: true });
      this.jobControllers.set(video.id, jobCtrl);
      try {
        await processJob(video, jobCtrl.signal);
        onSuccess(video);
      } catch (err) {
        if (this.controller.signal.aborted) {
          // Shutdown in progress — leave the job as active; startup reset will requeue it.
          logger.debug(`[${name}/${index}] aborted job ${video.id} during shutdown`);
          return;
        }
        if (jobCtrl.signal.aborted) {
          // Per-job cancellation (e.g. from a delete request). The caller
          // is responsible for cleaning up DB state; just log and move on.
          logger.debug(`[${name}/${index}] cancelled job ${video.id}`);
        } else {
          onFailure(video, toError(err));
        }
      } finally {
        this.controller.signal.removeEventListener("abort", onPoolAbort);
        this.jobControllers.delete(video.id);
      }
    }
  }

  private park(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.running) {
        resolve();
        return;
      }
      this.wakers.push(resolve);
    });
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
