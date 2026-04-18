import type { Database } from "better-sqlite3";
import type { Video } from "../db/videos";
import type { VideoStatus } from "../db/schema";

export type Stage = "download" | "convert" | "upload";

interface StageTransitions {
  queued: VideoStatus;
  active: VideoStatus;
  failed: VideoStatus;
  next: VideoStatus; // status after success
}

export const STAGES: Record<Stage, StageTransitions> = {
  download: {
    queued: "DOWNLOAD_QUEUED",
    active: "DOWNLOADING",
    failed: "DOWNLOAD_FAILED",
    next: "CONVERT_QUEUED",
  },
  convert: {
    queued: "CONVERT_QUEUED",
    active: "CONVERTING",
    failed: "CONVERT_FAILED",
    next: "UPLOAD_QUEUED",
  },
  upload: {
    queued: "UPLOAD_QUEUED",
    active: "UPLOADING",
    failed: "UPLOAD_FAILED",
    next: "UPLOADED",
  },
};

// ── Atomic operations ───────────────────────────────────────────────

/**
 * Atomically pick the oldest queued video for this stage and mark it active.
 * Returns the claimed video, or null if the queue is empty.
 */
export function claimNextJob(db: Database, stage: Stage): Video | null {
  const cfg = STAGES[stage];
  return db.transaction((): Video | null => {
    const row = db
      .prepare("SELECT * FROM videos WHERE status = ? ORDER BY created_at LIMIT 1")
      .get(cfg.queued) as Video | undefined;
    if (!row) return null;
    const now = new Date().toISOString();
    db.prepare("UPDATE videos SET status = ?, progress_pct = 0, updated_at = ? WHERE id = ?")
      .run(cfg.active, now, row.id);
    return { ...row, status: cfg.active, progress_pct: 0, updated_at: now };
  })();
}

/**
 * Mark a job succeeded and transition to the next stage's queue (or UPLOADED).
 */
export function markJobSucceeded(db: Database, videoId: number, stage: Stage): void {
  const cfg = STAGES[stage];
  const now = new Date().toISOString();
  db.prepare("UPDATE videos SET status = ?, progress_pct = ?, error_message = NULL, updated_at = ? WHERE id = ?")
    .run(cfg.next, stage === "upload" ? 100 : 0, now, videoId);
}

/**
 * Mark a job failed, preserving the error message.
 */
export function markJobFailed(db: Database, videoId: number, stage: Stage, error: string): void {
  const cfg = STAGES[stage];
  const now = new Date().toISOString();
  db.prepare("UPDATE videos SET status = ?, error_message = ?, updated_at = ? WHERE id = ?")
    .run(cfg.failed, error, now, videoId);
}

/**
 * Reset any videos left in a `*ING` state back to their `*_QUEUED` status.
 * Called once on daemon startup to recover from a crash or unclean shutdown.
 * Returns the number of jobs reset.
 */
export function resetStaleJobs(db: Database): number {
  const now = new Date().toISOString();
  let total = 0;
  for (const cfg of Object.values(STAGES)) {
    const result = db
      .prepare("UPDATE videos SET status = ?, progress_pct = 0, updated_at = ? WHERE status = ?")
      .run(cfg.queued, now, cfg.active);
    total += Number(result.changes);
  }
  return total;
}
