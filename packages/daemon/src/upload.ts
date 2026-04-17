import { openAsBlob } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { Config, Logger } from "@yt2pt/shared";

// ── Helpers ─────────────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mkv": "video/x-matroska",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".vtt": "text/vtt",
  ".srt": "application/x-subrip",
};

function mimeType(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function apiUrl(config: Config): string {
  return config.peertube.instance_url.replace(/\/+$/, "") + "/api/v1";
}

function assertResponse(res: Response, label: string, body: string): void {
  if (!res.ok) {
    throw new Error(`${label} failed (${res.status}): ${body}`);
  }
}

// ── API calls ───────────────────────────────────────────────────────

async function uploadVideoFile(
  api: string,
  token: string,
  videoDir: string,
  meta: Record<string, unknown>,
  log: Logger
): Promise<string> {
  const videoFilePath = join(videoDir, meta["videoFile"] as string);
  const blob = await openAsBlob(videoFilePath, { type: mimeType(videoFilePath) });

  const form = new FormData();
  form.append("videofile", blob, meta["videoFile"] as string);

  // Required
  form.append("channelId", String(meta["channelId"]));
  form.append("name", meta["name"] as string);

  // Optional scalars
  if (meta["description"]) form.append("description", meta["description"] as string);
  if (meta["category"] != null) form.append("category", String(meta["category"]));
  if (meta["licence"] != null) form.append("licence", String(meta["licence"]));
  if (meta["language"]) form.append("language", meta["language"] as string);
  if (meta["privacy"] != null) form.append("privacy", String(meta["privacy"]));
  if (meta["originallyPublishedAt"]) form.append("originallyPublishedAt", meta["originallyPublishedAt"] as string);
  form.append("nsfw", String(meta["nsfw"] ?? false));
  form.append("waitTranscoding", String(meta["waitTranscoding"] ?? true));
  form.append("commentsPolicy", String(meta["commentsPolicy"] ?? 1));
  form.append("downloadEnabled", String(meta["downloadEnabled"] ?? true));
  form.append("generateTranscription", String(meta["generateTranscription"] ?? true));

  // Tags (array)
  const tags = meta["tags"] as string[] | undefined;
  if (tags && tags.length > 0) {
    for (const tag of tags) {
      form.append("tags[]", tag);
    }
  }

  log.debug(`  POST ${api}/videos/upload`);
  const res = await fetch(`${api}/videos/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  const body = await res.text();
  assertResponse(res, "Video upload", body);

  const data = JSON.parse(body) as { video: { id: number; uuid: string; shortUUID: string } };
  return data.video.uuid;
}

async function setThumbnail(
  api: string,
  token: string,
  videoUuid: string,
  videoDir: string,
  meta: Record<string, unknown>,
  log: Logger
): Promise<void> {
  const thumbnailPath = join(videoDir, meta["thumbnailFile"] as string);
  const blob = await openAsBlob(thumbnailPath, { type: mimeType(thumbnailPath) });

  const form = new FormData();
  form.append("thumbnailfile", blob, meta["thumbnailFile"] as string);

  log.debug(`  PUT ${api}/videos/${videoUuid}`);
  const res = await fetch(`${api}/videos/${videoUuid}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  const body = await res.text();
  assertResponse(res, "Thumbnail upload", body);
}

async function uploadSubtitles(
  api: string,
  token: string,
  videoUuid: string,
  videoDir: string,
  subtitles: { language: string; file: string }[],
  log: Logger
): Promise<void> {
  for (const sub of subtitles) {
    const captionPath = join(videoDir, "subtitles", sub.file);
    const blob = await openAsBlob(captionPath, { type: mimeType(captionPath) });

    const form = new FormData();
    form.append("captionfile", blob, sub.file);

    log.debug(`  PUT ${api}/videos/${videoUuid}/captions/${sub.language}`);
    const res = await fetch(`${api}/videos/${videoUuid}/captions/${sub.language}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });

    const body = await res.text();
    assertResponse(res, `Subtitle upload (${sub.language})`, body);
    log.info(`  Subtitle uploaded: ${sub.language}`);
  }
}

async function setChapters(
  api: string,
  token: string,
  videoUuid: string,
  chapters: { chapters: { timecode: number; title: string }[] },
  log: Logger
): Promise<void> {
  log.debug(`  PUT ${api}/videos/${videoUuid}/chapters`);
  const res = await fetch(`${api}/videos/${videoUuid}/chapters`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(chapters),
  });

  const body = await res.text();
  assertResponse(res, "Set chapters", body);
}

// ── Main upload entry point ─────────────────────────────────────────

export async function uploadToPeertube(config: Config, log: Logger): Promise<void> {
  const { instance_url, api_token } = config.peertube;

  if (!instance_url) {
    log.error("peertube.instance_url is not configured — set it in yt2pt.conf.toml");
    process.exit(1);
  }
  if (!api_token) {
    log.error("peertube.api_token is not configured — see README for how to get one");
    process.exit(1);
  }

  const api = apiUrl(config);
  const uploadRoot = resolve(config.yt2pt.data_dir, "upload_to_peertube");

  let channelDirs: string[];
  try {
    channelDirs = await readdir(uploadRoot);
  } catch {
    log.error(`No converted videos found at ${uploadRoot}`);
    process.exit(1);
  }

  let uploadedCount = 0;

  for (const channel of channelDirs) {
    const channelPath = join(uploadRoot, channel);
    let videoDirs: string[];
    try {
      videoDirs = await readdir(channelPath);
    } catch {
      continue;
    }

    for (const videoDir of videoDirs) {
      const videoPath = join(channelPath, videoDir);

      // Read upload_video.json
      let uploadMeta: Record<string, unknown>;
      try {
        uploadMeta = JSON.parse(await readFile(join(videoPath, "upload_video.json"), "utf-8"));
      } catch {
        log.debug(`Skipping ${videoDir} — no valid upload_video.json`);
        continue;
      }

      // Use channelId from config if the JSON has an empty one
      if (!uploadMeta["channelId"]) {
        uploadMeta["channelId"] = config.peertube.channel_id;
      }
      if (!uploadMeta["channelId"]) {
        log.error(`Skipping ${videoDir} — no channelId configured`);
        continue;
      }

      log.info(`Uploading: ${uploadMeta["name"]}`);

      // 1. Upload video
      let videoUuid: string;
      try {
        videoUuid = await uploadVideoFile(api, api_token, videoPath, uploadMeta, log);
        log.info(`  Video uploaded (uuid: ${videoUuid})`);
      } catch (err) {
        log.error(`  ${(err as Error).message}`);
        continue;
      }

      // 2. Set thumbnail
      try {
        const raw = await readFile(join(videoPath, "set_thumbnail.json"), "utf-8");
        const thumbMeta = JSON.parse(raw) as Record<string, unknown>;
        await setThumbnail(api, api_token, videoUuid, videoPath, thumbMeta, log);
        log.info("  Thumbnail set");
      } catch (err) {
        log.error(`  Thumbnail: ${(err as Error).message}`);
      }

      // 3. Upload subtitles (optional)
      try {
        const raw = await readFile(join(videoPath, "upload_subtitles.json"), "utf-8");
        const subs = JSON.parse(raw) as { language: string; file: string }[];
        await uploadSubtitles(api, api_token, videoUuid, videoPath, subs, log);
      } catch {
        // No subtitles file — that's fine
      }

      // 4. Set chapters (optional)
      try {
        const raw = await readFile(join(videoPath, "set_chapters.json"), "utf-8");
        const chapters = JSON.parse(raw) as { chapters: { timecode: number; title: string }[] };
        await setChapters(api, api_token, videoUuid, chapters, log);
        log.info("  Chapters set");
      } catch {
        // No chapters file — that's fine
      }

      uploadedCount++;

      // Optionally delete upload folder after successful upload
      if (config.yt2pt.remove_video_after_upload) {
        await rm(videoPath, { recursive: true, force: true });
        log.info(`  Deleted: ${videoPath}`);
      }
    }
  }

  if (uploadedCount === 0) {
    log.info("No videos to upload");
  } else {
    log.info(`Uploaded ${uploadedCount} video(s) to PeerTube`);
  }
}
