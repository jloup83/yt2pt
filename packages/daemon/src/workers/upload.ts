import { openAsBlob } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Config, Logger } from "@yt2pt/shared";
import type { PeertubeConnection } from "../peertube/connection";

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".mkv": "video/x-matroska", ".mp4": "video/mp4",
  ".webm": "video/webm", ".vtt": "text/vtt", ".srt": "application/x-subrip",
};

function mimeType(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

async function assertOk(res: Response, label: string): Promise<void> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${label} failed (${res.status}): ${body}`);
  }
}

/**
 * Upload one converted video folder to PeerTube using the injected
 * connection (so 401s trigger a token re-check and retry).
 * Throws on failure.
 */
export async function runUpload(
  videoPath: string,
  config: Config,
  peertube: PeertubeConnection,
  log: Logger,
  signal?: AbortSignal,
  onProgress?: (pct: number) => void
): Promise<string> {
  if (signal?.aborted) throw new Error("aborted");

  const uploadMeta = JSON.parse(
    await readFile(join(videoPath, "upload_video.json"), "utf-8")
  ) as Record<string, unknown>;

  // The convert stage is responsible for writing a valid channelId (per-channel
  // row first, global config as last resort). If it's missing here, the
  // upload metadata was written by a buggy/older convert — fail loudly.
  if (!uploadMeta["channelId"]) {
    throw new Error(
      `upload_video.json is missing channelId (re-run convert for this video; see issue #94)`,
    );
  }

  // ── 1. Upload video file ─────────────────────────────────────────
  const videoFile = uploadMeta["videoFile"] as string;
  const videoFilePath = join(videoPath, videoFile);
  const videoBlob = await openAsBlob(videoFilePath, { type: mimeType(videoFilePath) });

  const form = new FormData();
  form.append("videofile", videoBlob, videoFile);
  form.append("channelId", String(uploadMeta["channelId"]));
  form.append("name", uploadMeta["name"] as string);
  if (uploadMeta["description"]) form.append("description", uploadMeta["description"] as string);
  if (uploadMeta["category"] != null) form.append("category", String(uploadMeta["category"]));
  if (uploadMeta["licence"] != null) form.append("licence", String(uploadMeta["licence"]));
  if (uploadMeta["language"]) form.append("language", uploadMeta["language"] as string);
  if (uploadMeta["privacy"] != null) form.append("privacy", String(uploadMeta["privacy"]));
  if (uploadMeta["originallyPublishedAt"]) form.append("originallyPublishedAt", uploadMeta["originallyPublishedAt"] as string);
  form.append("nsfw", String(uploadMeta["nsfw"] ?? false));
  form.append("waitTranscoding", String(uploadMeta["waitTranscoding"] ?? true));
  form.append("commentsPolicy", String(uploadMeta["commentsPolicy"] ?? 1));
  form.append("downloadEnabled", String(uploadMeta["downloadEnabled"] ?? true));
  form.append("generateTranscription", String(uploadMeta["generateTranscription"] ?? true));
  const tags = uploadMeta["tags"] as string[] | undefined;
  if (tags) for (const t of tags) form.append("tags[]", t);

  log.debug("POST /videos/upload");
  const videoRes = await peertube.authFetch("/videos/upload", { method: "POST", body: form });
  await assertOk(videoRes, "Video upload");
  const videoJson = (await videoRes.json()) as { video: { uuid: string } };
  const videoUuid = videoJson.video.uuid;
  log.info(`  Video uploaded (uuid: ${videoUuid})`);
  onProgress?.(70);

  if (signal?.aborted) throw new Error("aborted");

  // ── 2. Thumbnail ─────────────────────────────────────────────────
  try {
    const raw = await readFile(join(videoPath, "set_thumbnail.json"), "utf-8");
    const thumbMeta = JSON.parse(raw) as Record<string, unknown>;
    const thumbPath = join(videoPath, thumbMeta["thumbnailFile"] as string);
    const thumbBlob = await openAsBlob(thumbPath, { type: mimeType(thumbPath) });
    const tForm = new FormData();
    tForm.append("thumbnailfile", thumbBlob, thumbMeta["thumbnailFile"] as string);
    const res = await peertube.authFetch(`/videos/${videoUuid}`, { method: "PUT", body: tForm });
    await assertOk(res, "Thumbnail upload");
    log.info("  Thumbnail set");
  } catch (err) {
    log.error(`  Thumbnail: ${(err as Error).message}`);
  }
  onProgress?.(85);

  if (signal?.aborted) throw new Error("aborted");

  // ── 3. Subtitles (optional) ──────────────────────────────────────
  try {
    const raw = await readFile(join(videoPath, "upload_subtitles.json"), "utf-8");
    const subs = JSON.parse(raw) as { language: string; file: string }[];
    for (const sub of subs) {
      const capPath = join(videoPath, "subtitles", sub.file);
      const capBlob = await openAsBlob(capPath, { type: mimeType(capPath) });
      const sForm = new FormData();
      sForm.append("captionfile", capBlob, sub.file);
      const res = await peertube.authFetch(
        `/videos/${videoUuid}/captions/${sub.language}`,
        { method: "PUT", body: sForm }
      );
      await assertOk(res, `Subtitle upload (${sub.language})`);
      log.info(`  Subtitle uploaded: ${sub.language}`);
    }
  } catch {
    // No subtitles file — ok
  }
  onProgress?.(95);

  if (signal?.aborted) throw new Error("aborted");

  // ── 4. Chapters (optional) ───────────────────────────────────────
  try {
    const raw = await readFile(join(videoPath, "set_chapters.json"), "utf-8");
    const chapters = JSON.parse(raw) as { chapters: { timecode: number; title: string }[] };
    const res = await peertube.authFetch(`/videos/${videoUuid}/chapters`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chapters),
    });
    await assertOk(res, "Set chapters");
    log.info("  Chapters set");
  } catch {
    // No chapters file — ok
  }

  if (config.yt2pt.remove_video_after_upload) {
    await rm(videoPath, { recursive: true, force: true });
    log.info(`  Deleted: ${videoPath}`);
  }

  return videoUuid;
}
