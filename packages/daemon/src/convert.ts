import { readFileSync } from "node:fs";
import { mkdir, writeFile, copyFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Config, Logger } from "@yt2pt/shared";

// ── YouTube → PeerTube category mapping ─────────────────────────────

const YOUTUBE_TO_PEERTUBE_CATEGORY: Record<string, number> = {
  "Music": 1,
  "Film & Animation": 2,
  "Autos & Vehicles": 3,
  "Sports": 5,
  "Travel & Events": 6,
  "Gaming": 7,
  "People & Blogs": 8,
  "Comedy": 9,
  "Entertainment": 10,
  "News & Politics": 11,
  "Howto & Style": 12,
  "Education": 13,
  "Nonprofits & Activism": 14,
  "Science & Technology": 15,
  "Pets & Animals": 16,
};

// ── PeerTube privacy mapping ────────────────────────────────────────

const PRIVACY_MAP: Record<string, number> = {
  "public": 1,
  "unlisted": 2,
  "private": 3,
  "internal": 4,
  "password_protected": 5,
};

// ── PeerTube comments policy mapping ────────────────────────────────

const COMMENTS_POLICY_MAP: Record<string, number> = {
  "enabled": 1,
  "disabled": 2,
  "requires_approval": 3,
};

// ── PeerTube licence mapping ────────────────────────────────────────

const LICENCE_MAP: Record<string, number> = {
  "Attribution": 1,
  "Attribution - Share Alike": 2,
  "Attribution - No Derivatives": 3,
  "Attribution - Non Commercial": 4,
  "Attribution - Non Commercial - Share Alike": 5,
  "Attribution - Non Commercial - No Derivatives": 6,
  "Public Domain Dedication": 7,
};

// ── Helpers ─────────────────────────────────────────────────────────

function mapCategory(categories: string[] | null): number | null {
  if (!Array.isArray(categories)) return null;
  for (const cat of categories) {
    if (YOUTUBE_TO_PEERTUBE_CATEGORY[cat] !== undefined) {
      return YOUTUBE_TO_PEERTUBE_CATEGORY[cat];
    }
  }
  return null;
}

function filterTags(tags: string[] | null): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .filter((t) => t.length >= 2 && t.length <= 30)
    .slice(0, 5);
}

function mapLicence(license: string | null): number | null {
  if (!license) return null;
  return LICENCE_MAP[license] ?? null;
}

function toOriginallyPublishedAt(uploadDate: string | null): string | null {
  if (!uploadDate || uploadDate.length !== 8) return null;
  return `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}T00:00:00.000Z`;
}

// ── Build per-API JSON payloads ─────────────────────────────────────

function buildUploadVideo(raw: Record<string, unknown>, videoFile: string, config: Config): Record<string, unknown> {
  const title = raw["title"] as string;
  const categories = raw["categories"] as string[] | null;
  const tags = raw["tags"] as string[] | null;
  const license = raw["license"] as string | null;
  const uploadDate = raw["upload_date"] as string | null;

  return {
    name: title.slice(0, 120),
    description: raw["description"] as string || "",
    category: mapCategory(categories),
    licence: mapLicence(license),
    language: (raw["language"] as string) || config.peertube.language || null,
    tags: filterTags(tags),
    nsfw: false,
    privacy: PRIVACY_MAP[config.peertube.privacy] ?? 1,
    channelId: config.peertube.channel_id,
    originallyPublishedAt: toOriginallyPublishedAt(uploadDate),
    waitTranscoding: config.peertube.wait_transcoding,
    commentsPolicy: COMMENTS_POLICY_MAP[config.peertube.comments_policy] ?? 1,
    downloadEnabled: true,
    generateTranscription: config.peertube.generate_transcription,
    videoFile,
  };
}

function buildSetThumbnail(thumbnailFile: string): Record<string, unknown> {
  return { thumbnailFile };
}

function buildUploadSubtitles(subtitleFiles: string[]): { language: string; file: string }[] {
  return subtitleFiles.map((f) => {
    const parts = f.replace(/\.vtt$/, "").split(".");
    const language = parts.length >= 2 ? parts[parts.length - 1] : "unknown";
    return { language, file: f };
  });
}

function buildSetChapters(chapters: { start_time: number; title: string }[] | null): { chapters: { timecode: number; title: string }[] } | null {
  if (!Array.isArray(chapters) || chapters.length === 0) return null;
  return {
    chapters: chapters.map((ch) => ({ timecode: ch.start_time, title: ch.title })),
  };
}

// ── Main convert entry point ────────────────────────────────────────

export async function convertMetadata(config: Config, log: Logger): Promise<void> {
  const sourceRoot = resolve(config.yt2pt.data_dir, "downloaded_from_youtube");
  const targetRoot = resolve(config.yt2pt.data_dir, "upload_to_peertube");

  let channelDirs: string[];
  try {
    channelDirs = await readdir(sourceRoot);
  } catch {
    log.error(`No downloaded videos found at ${sourceRoot}`);
    process.exit(1);
  }

  let convertedCount = 0;

  for (const channel of channelDirs) {
    const channelPath = join(sourceRoot, channel);
    let videoDirs: string[];
    try {
      videoDirs = await readdir(channelPath);
    } catch {
      continue;
    }

    for (const videoDir of videoDirs) {
      const sourcePath = join(channelPath, videoDir);
      const metadataFile = join(sourcePath, "metadata.json");

      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(readFileSync(metadataFile, "utf-8")) as Record<string, unknown>;
      } catch {
        log.debug(`Skipping ${videoDir} — no valid metadata.json`);
        continue;
      }

      const targetPath = join(targetRoot, channel, videoDir);
      await mkdir(targetPath, { recursive: true });

      // Copy video file
      const sourceFiles = await readdir(sourcePath);
      const videoFile = sourceFiles.find((f) => f.endsWith(`.${raw["_ext"] as string}`) && !f.endsWith(".part"));
      if (!videoFile) {
        log.error(`No video file found in ${sourcePath}, skipping`);
        continue;
      }
      await copyFile(join(sourcePath, videoFile), join(targetPath, videoFile));
      log.debug(`Video copied: ${videoFile}`);

      // Write upload_video.json
      const uploadVideo = buildUploadVideo(raw, videoFile, config);
      await writeFile(join(targetPath, "upload_video.json"), JSON.stringify(uploadVideo, null, 2) + "\n");

      // Copy thumbnail and write set_thumbnail.json
      const thumbnailFile = raw["_thumbnail_file"] as string | undefined;
      if (thumbnailFile) {
        await copyFile(join(sourcePath, thumbnailFile), join(targetPath, thumbnailFile));
        const setThumbnail = buildSetThumbnail(thumbnailFile);
        await writeFile(join(targetPath, "set_thumbnail.json"), JSON.stringify(setThumbnail, null, 2) + "\n");
        log.debug(`Thumbnail copied: ${thumbnailFile}`);
      }

      // Copy subtitles and write upload_subtitles.json
      const subtitleFiles = (raw["_subtitle_files"] as string[]) || [];
      if (subtitleFiles.length > 0) {
        const targetSubsDir = join(targetPath, "subtitles");
        await mkdir(targetSubsDir, { recursive: true });
        for (const sub of subtitleFiles) {
          await copyFile(join(sourcePath, "subtitles", sub), join(targetSubsDir, sub));
          log.debug(`Subtitle copied: ${sub}`);
        }
        const uploadSubtitles = buildUploadSubtitles(subtitleFiles);
        await writeFile(join(targetPath, "upload_subtitles.json"), JSON.stringify(uploadSubtitles, null, 2) + "\n");
      }

      // Write set_chapters.json
      const chapters = raw["chapters"] as { start_time: number; title: string }[] | null;
      const setChapters = buildSetChapters(chapters);
      if (setChapters) {
        await writeFile(join(targetPath, "set_chapters.json"), JSON.stringify(setChapters, null, 2) + "\n");
      }

      convertedCount++;
      log.info(`Converted: ${videoDir}`);

      // Optionally delete source folder
      if (config.yt2pt.remove_video_after_metadata_conversion) {
        await rm(sourcePath, { recursive: true, force: true });
        log.info(`Deleted source: ${sourcePath}`);
      }
    }
  }

  if (convertedCount === 0) {
    log.info("No videos to convert");
  } else {
    log.info(`Converted ${convertedCount} video(s) to PeerTube format`);
  }
}
