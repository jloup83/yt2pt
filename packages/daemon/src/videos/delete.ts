import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "better-sqlite3";
import type { Logger, ResolvedPaths } from "@yt2pt/shared";
import type { PeertubeConnection } from "../peertube/connection";
import type { JobQueue } from "../queue";
import type { Video } from "../db/videos";
import { deleteVideo, getVideoById } from "../db/videos";
import { channelSlugFromFolderName } from "../workers/paths";

/**
 * Result of a single-video delete orchestration. `cancelled` is true
 * when the video had an in-flight job that we aborted. `peertube_deleted`
 * is true iff we attempted and succeeded; null means we did not attempt
 * (e.g. no uuid, or the caller opted out).
 */
export interface DeleteVideoResult {
  id: number;
  cancelled: boolean;
  peertube_deleted: boolean | null;
  warnings: string[];
}

export interface DeleteVideoContext {
  db: Database;
  paths: ResolvedPaths;
  logger: Logger;
  queue?: JobQueue;
  peertube?: PeertubeConnection;
}

export interface DeleteVideoOptions {
  fromPeertube: boolean;
}

/**
 * Thrown when the PeerTube delete request fails in a way the caller
 * has asked to treat as hard failure (auth / 5xx / non-404). Carries
 * the HTTP status.
 */
export class PeertubeDeleteError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PeertubeDeleteError";
    this.status = status;
  }
}

/**
 * Remove both the downloaded and the converted-for-PeerTube copies of
 * the video's folder, if they exist. Resolves quietly when folders are
 * already gone (idempotent).
 */
export async function deleteLocalVideoFiles(
  paths: ResolvedPaths,
  video: Video,
  logger: Logger,
): Promise<void> {
  if (!video.folder_name) return;
  const slug = channelSlugFromFolderName(video.folder_name);
  if (!slug) {
    logger.debug(`[delete] video ${video.id}: cannot parse channel slug from ${video.folder_name}`);
    return;
  }
  const targets = [
    resolve(paths.dataDir, "downloaded_from_youtube", slug, video.folder_name),
    resolve(paths.dataDir, "upload_to_peertube", slug, video.folder_name),
  ];
  for (const t of targets) {
    try {
      await rm(t, { recursive: true, force: true });
    } catch (err) {
      logger.error(`[delete] video ${video.id}: failed to remove ${t}: ${(err as Error).message}`);
    }
  }
}

/**
 * DELETE the video from PeerTube by uuid. A 404 response is treated as
 * success (already gone). Any other non-ok response throws a
 * `PeertubeDeleteError` so the caller can surface 502 to the API client
 * and leave local state intact.
 */
export async function deletePeertubeVideo(
  conn: PeertubeConnection,
  uuid: string,
): Promise<void> {
  const res = await conn.authFetch(`/videos/${uuid}`, { method: "DELETE" });
  if (res.ok || res.status === 204) return;
  if (res.status === 404) return; // already gone — not an error
  const body = await res.text().catch(() => "");
  throw new PeertubeDeleteError(
    res.status,
    `PeerTube DELETE /videos/${uuid} failed: ${res.status} ${body.slice(0, 200)}`,
  );
}

/**
 * Full orchestrated delete of one video row:
 *
 *   1. Cancel any in-flight job for this video.
 *   2. If requested and a PT uuid is on record, DELETE the video on PT.
 *   3. Remove the local downloaded + converted directories.
 *   4. Delete the DB row.
 *
 * Step 2 failures (non-404) abort the flow with a `PeertubeDeleteError`
 * *before* touching local state. Step 3 failures are logged as warnings
 * but do not block the DB deletion — the files can always be cleaned
 * manually later.
 */
export async function deleteVideoOrchestrator(
  ctx: DeleteVideoContext,
  video: Video,
  opts: DeleteVideoOptions,
): Promise<DeleteVideoResult> {
  const warnings: string[] = [];

  // Step 1: cancel any in-flight job.
  const cancelled = ctx.queue?.cancelVideo(video.id) ?? false;
  if (cancelled) {
    ctx.logger.info(`[delete] video ${video.id}: cancelled in-flight job`);
    // Give the worker a moment to unwind before we delete files it may
    // still be touching. Callers with stricter requirements can poll
    // isActive(); here we use a small yield.
    await new Promise((r) => setTimeout(r, 50));
  }

  // Step 2: PeerTube delete (optional).
  let peertubeDeleted: boolean | null = null;
  if (opts.fromPeertube) {
    if (!video.peertube_video_uuid) {
      warnings.push("no peertube uuid on record — skipping PeerTube delete");
    } else if (!ctx.peertube) {
      warnings.push("PeerTube connection not available — skipping PeerTube delete");
    } else {
      await deletePeertubeVideo(ctx.peertube, video.peertube_video_uuid);
      peertubeDeleted = true;
    }
  }

  // Step 3: local files.
  try {
    await deleteLocalVideoFiles(ctx.paths, video, ctx.logger);
  } catch (err) {
    warnings.push(`local file cleanup failed: ${(err as Error).message}`);
  }

  // Step 4: DB row.
  deleteVideo(ctx.db, video.id);
  ctx.logger.info(`[delete] video ${video.id}: removed from db`);

  return { id: video.id, cancelled, peertube_deleted: peertubeDeleted, warnings };
}

/**
 * Convenience: look up the video by id and run the orchestrator. Returns
 * `null` if the id is unknown (route layer maps that to 404).
 */
export async function deleteVideoById(
  ctx: DeleteVideoContext,
  id: number,
  opts: DeleteVideoOptions,
): Promise<DeleteVideoResult | null> {
  const video = getVideoById(ctx.db, id);
  if (!video) return null;
  return deleteVideoOrchestrator(ctx, video, opts);
}
