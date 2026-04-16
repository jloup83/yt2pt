#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile, access, readdir, rmdir } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { loadConfig, printConfig, Config } from "./config";
import { createLogger, Logger } from "./logger";

const { version: VERSION } = JSON.parse(
  readFileSync(resolve(__dirname, "..", "package.json"), "utf-8")
);

const HELP = `yt2pt v${VERSION} — Download YouTube videos with metadata and thumbnails

Usage:
  yt2pt <youtube-url>    Download video, thumbnail, and metadata
  yt2pt -h, --help       Show this help
  yt2pt -v, --version    Show version

Examples:
  yt2pt https://www.youtube.com/watch?v=q5Mq4kEa7pA
  yt2pt https://youtu.be/q5Mq4kEa7pA
`;

const METADATA_FIELDS = [
  "channel",
  "channel_id",
  "channel_url",
  "id",
  "title",
  "ext",
  "description",
  "upload_date",
  "webpage_url",
  "duration",
  "duration_string",
  "language",
  "categories",
  "tags",
  "license",
  "age_limit",
  "chapters",
] as const;

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

interface VideoMetadata {
  channel: string;
  channel_id: string;
  channel_url: string;
  id: string;
  title: string;
  ext: string;
  description: string;
  upload_date: string;
  video_url: string;
  duration: number | null;
  duration_string: string | null;
  language: string | null;
  categories: string[] | null;
  tags: string[] | null;
  licence: string | null;
  nsfw: boolean;
  chapters: { timecode: number; title: string }[] | null;
  category: number | null;
  originallyPublishedAt: string | null;
  captions: string[];
  thumbnail: string;
}

function sanitize(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .toLowerCase()
    .replace(/\s+/g, "_")           // whitespace → underscore
    .replace(/[^a-z0-9_-]/g, "")    // keep only letters, digits, hyphens, underscores
    .replace(/_+/g, "_")            // collapse consecutive underscores
    .replace(/^[_-]+|[_-]+$/g, ""); // trim leading/trailing underscores and hyphens
}

function formatDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${cmd} failed: ${stderr || error.message}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function findYtDlpBinary(): Promise<string> {
  const binDir = resolve(__dirname, "..", "bin");
  try {
    await access(binDir);
  } catch {
    throw new Error(`bin/ directory not found at ${binDir}`);
  }

  let platform: string;
  switch (process.platform) {
    case "darwin":
      platform = "macos";
      break;
    case "linux":
      platform = "linux";
      break;
    case "win32":
      throw new Error("Windows is not supported yet");
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }

  const entries = await readdir(binDir);
  const ytdlp = entries.find((f) => f.startsWith(`yt-dlp-${platform}-`));
  if (!ytdlp) {
    throw new Error(`No yt-dlp binary found for ${platform} in ${binDir}`);
  }
  return join(binDir, ytdlp);
}

function isYouTubeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /^(www\.)?(youtube\.com|youtu\.be|m\.youtube\.com|music\.youtube\.com)$/.test(parsed.hostname);
  } catch {
    return false;
  }
}

async function fetchMetadata(ytdlp: string, url: string): Promise<Record<string, unknown>> {
  const { stdout } = await run(ytdlp, ["--dump-json", "--skip-download", url]);
  return JSON.parse(stdout) as Record<string, unknown>;
}

function buildMetadata(raw: Record<string, unknown>): VideoMetadata {
  const meta: Record<string, unknown> = {};
  for (const field of METADATA_FIELDS) {
    if (field === "webpage_url") {
      meta["video_url"] = raw[field] ?? null;
    } else if (field === "license") {
      meta["licence"] = raw[field] ?? null;
    } else if (field === "age_limit") {
      meta["nsfw"] = false;
    } else if (field === "chapters") {
      const rawChapters = raw[field] as { start_time: number; title: string }[] | null;
      meta["chapters"] = rawChapters
        ? rawChapters.map((ch) => ({ timecode: ch.start_time, title: ch.title }))
        : null;
    } else {
      meta[field] = raw[field] ?? null;
    }
  }

  // Filter tags to PeerTube constraints: max 5, 2–30 chars each
  if (Array.isArray(meta["tags"])) {
    meta["tags"] = (meta["tags"] as string[])
      .filter((t) => t.length >= 2 && t.length <= 30)
      .slice(0, 5);
  }

  // Map YouTube categories to PeerTube category ID
  const cats = meta["categories"] as string[] | null;
  meta["category"] = null;
  if (Array.isArray(cats)) {
    for (const cat of cats) {
      if (YOUTUBE_TO_PEERTUBE_CATEGORY[cat] !== undefined) {
        meta["category"] = YOUTUBE_TO_PEERTUBE_CATEGORY[cat];
        break;
      }
    }
  }

  // Convert upload_date (YYYYMMDD) to ISO 8601 for PeerTube originallyPublishedAt
  const uploadDate = meta["upload_date"] as string | null;
  meta["originallyPublishedAt"] = uploadDate && uploadDate.length === 8
    ? `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}T00:00:00.000Z`
    : null;

  // These fields will be set after download
  meta["captions"] = [];
  meta["thumbnail"] = "";
  return meta as unknown as VideoMetadata;
}

async function downloadVideo(
  ytdlp: string,
  url: string,
  outputDir: string,
  videoFilename: string,
  config: Config
): Promise<void> {
  const outputPath = join(outputDir, videoFilename);
  await run(ytdlp, [
    "-f",
    config.ytdlp.format,
    "--merge-output-format",
    config.ytdlp.merge_output_format,
    "-o",
    outputPath,
    url,
  ]);
}

async function downloadCaptions(
  ytdlp: string,
  url: string,
  outputDir: string
): Promise<string[]> {
  const captionsDir = join(outputDir, "captions");
  await mkdir(captionsDir, { recursive: true });

  await run(ytdlp, [
    "--skip-download",
    "--write-subs",
    "--write-auto-subs",
    "--sub-format", "vtt",
    "-o", join(captionsDir, "%(id)s"),
    url,
  ]);

  const entries = await readdir(captionsDir);
  const vttFiles = entries.filter((f) => f.endsWith(".vtt"));

  if (vttFiles.length === 0) {
    // Remove empty captions directory
    await rmdir(captionsDir).catch(() => {});
  }

  return vttFiles;
}

async function downloadThumbnail(
  ytdlp: string,
  url: string,
  outputDir: string,
  config: Config
): Promise<string> {
  // Download just the thumbnail
  await run(ytdlp, [
    "--skip-download",
    "--write-thumbnail",
    "--convert-thumbnails",
    config.ytdlp.thumbnail_format,
    "-o",
    join(outputDir, "thumbnail"),
    url,
  ]);

  // yt-dlp names thumbnail files as thumbnail.jpg
  const entries = await readdir(outputDir);
  const thumb = entries.find((f) => f.startsWith("thumbnail") && f !== "thumbnail" && !f.endsWith(".part"));
  if (!thumb) {
    throw new Error("Failed to download thumbnail");
  }
  return thumb;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    console.log(HELP);
    process.exit(0);
  }

  if (args.includes("-v") || args.includes("--version")) {
    console.log(`yt2pt v${VERSION}`);
    process.exit(0);
  }

  const url = args[0]!;

  if (!isYouTubeUrl(url)) {
    console.error(`Error: Invalid YouTube URL: ${url}`);
    process.exit(1);
  }

  // Load and display configuration
  const { config, overrides } = loadConfig();
  const log = createLogger(config);
  printConfig(config, overrides, log);

  // Find yt-dlp binary
  let ytdlp: string;
  try {
    ytdlp = await findYtDlpBinary();
    log.debug(`yt-dlp binary: ${ytdlp}`);
  } catch (err) {
    log.error(`${(err as Error).message}`);
    process.exit(1);
  }

  log.info("Fetching video metadata...");
  let rawMeta: Record<string, unknown>;
  try {
    rawMeta = await fetchMetadata(ytdlp, url);
    log.debug(`Raw metadata keys: ${Object.keys(rawMeta).join(", ")}`);
  } catch (err) {
    log.error(`Failed to fetch metadata. ${(err as Error).message}`);
    process.exit(1);
  }

  const meta = buildMetadata(rawMeta);

  const channelDir = sanitize(meta.channel);
  const videoTitle = sanitize(meta.title);
  const publishedDate = formatDate(meta.upload_date);
  const videoId = meta.id;

  const folderName = `${channelDir}_${publishedDate}_${videoTitle}_[${videoId}]`;
  const videoFilename = `${channelDir}_${publishedDate}_${videoTitle}_[${videoId}]`;

  const outputDir = resolve(config.yt2pt.data_dir, channelDir, folderName);
  await mkdir(outputDir, { recursive: true });
  log.debug(`Output directory: ${outputDir}`);

  log.info(`Downloading video to ${outputDir}/...`);
  log.debug(`yt-dlp format: ${config.ytdlp.format}, container: ${config.ytdlp.merge_output_format}`);
  try {
    await downloadVideo(ytdlp, url, outputDir, videoFilename, config);
  } catch (err) {
    log.error(`Failed to download video. ${(err as Error).message}`);
    process.exit(1);
  }

  // Determine the actual video file extension
  const files = await readdir(outputDir);
  const videoFile = files.find((f) => f.startsWith(videoFilename) && !f.endsWith(".part"));
  const actualExt = videoFile ? extname(videoFile).slice(1) : config.ytdlp.merge_output_format;
  meta.ext = actualExt;

  log.info("Downloading thumbnail...");
  try {
    const thumbFilename = await downloadThumbnail(ytdlp, url, outputDir, config);
    meta.thumbnail = thumbFilename;
    log.debug(`Thumbnail saved: ${thumbFilename}`);
  } catch (err) {
    log.error(`Failed to download thumbnail. ${(err as Error).message}`);
    meta.thumbnail = "";
  }

  log.info("Downloading captions...");
  try {
    const captionFiles = await downloadCaptions(ytdlp, url, outputDir);
    meta.captions = captionFiles;
    if (captionFiles.length > 0) {
      log.info(`Downloaded ${captionFiles.length} caption(s)`);
      for (const f of captionFiles) {
        log.debug(`  - captions/${f}`);
      }
    } else {
      log.info("No captions available");
    }
  } catch (err) {
    log.error(`Failed to download captions. ${(err as Error).message}`);
    meta.captions = [];
  }

  // Write metadata.json
  await writeFile(join(outputDir, "metadata.json"), JSON.stringify(meta, null, 2) + "\n");
  log.debug("metadata.json written");

  log.info(`Done! Files saved to: ${outputDir}/`);
  const finalFiles = await readdir(outputDir);
  for (const f of finalFiles) {
    log.info(`  - ${f}`);
  }
}

main();
