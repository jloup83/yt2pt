import { resolve } from "node:path";
import type { Database } from "better-sqlite3";
import type { Config, Logger, ResolvedPaths } from "@yt2pt/shared";
import type { JobProcessor } from "../queue/pool";
import type { JobQueue } from "../queue";
import type { PeertubeConnection } from "../peertube/connection";
import { updateVideo } from "../db/videos";
import { findYtDlpBinary, channelSlugFromFolderName, youtubeUrl } from "./paths";
import { runDownload } from "./download";
import { runConvert } from "./convert";
import { runUpload } from "./upload";

export interface ProcessorContext {
  db: Database;
  config: Config;
  paths: ResolvedPaths;
  logger: Logger;
  peertube: PeertubeConnection;
  queue: JobQueue;
}

export interface Processors {
  download: JobProcessor;
  convert: JobProcessor;
  upload: JobProcessor;
}

/**
 * Build the three queue processors that drive video rows through the
 * download → convert → upload pipeline. The yt-dlp binary is resolved
 * lazily on first use so daemon startup doesn't fail if the bin is missing
 * at boot (the first download job will surface the error).
 */
export function createProcessors(ctx: ProcessorContext): Processors {
  const { db, config, paths, logger, peertube, queue } = ctx;

  let ytdlpPromise: Promise<string> | null = null;
  const ytdlp = (): Promise<string> => {
    if (!ytdlpPromise) ytdlpPromise = findYtDlpBinary(paths.binDir);
    return ytdlpPromise;
  };

  const download: JobProcessor = async (video, signal) => {
    const bin = await ytdlp();
    const url = youtubeUrl(video.youtube_video_id);
    const result = await runDownload(bin, url, config, paths, logger, signal, (pct) => {
      queue.reportProgress(video.id, pct);
    });
    updateVideo(db, video.id, {
      folder_name: result.folderName,
      title: video.title ?? null,
    });
  };

  const convert: JobProcessor = async (video, signal) => {
    if (!video.folder_name) throw new Error("video has no folder_name (download did not complete)");
    const channelSlug = channelSlugFromFolderName(video.folder_name);
    if (!channelSlug) throw new Error(`cannot parse channel slug from folder_name: ${video.folder_name}`);
    const sourcePath = resolve(paths.dataDir, "downloaded_from_youtube", channelSlug, video.folder_name);
    const targetPath = resolve(paths.dataDir, "upload_to_peertube", channelSlug, video.folder_name);
    queue.reportProgress(video.id, 10);
    await runConvert(sourcePath, targetPath, config, logger, signal);
    queue.reportProgress(video.id, 100);
  };

  const upload: JobProcessor = async (video, signal) => {
    if (!video.folder_name) throw new Error("video has no folder_name");
    const channelSlug = channelSlugFromFolderName(video.folder_name);
    if (!channelSlug) throw new Error(`cannot parse channel slug from folder_name: ${video.folder_name}`);
    const videoPath = resolve(paths.dataDir, "upload_to_peertube", channelSlug, video.folder_name);
    queue.reportProgress(video.id, 5);
    await runUpload(videoPath, config, peertube, logger, signal, (pct) => {
      queue.reportProgress(video.id, pct);
    });
  };

  return { download, convert, upload };
}
