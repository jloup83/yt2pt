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
      try {
        await processJob(video, this.controller.signal);
        onSuccess(video);
      } catch (err) {
        if (this.controller.signal.aborted) {
          // Shutdown in progress — leave the job as active; startup reset will requeue it.
          logger.debug(`[${name}/${index}] aborted job ${video.id} during shutdown`);
          return;
        }
        onFailure(video, toError(err));
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
