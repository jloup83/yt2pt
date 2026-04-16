#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile, access, readdir } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { loadConfig, printConfig, Config } from "./config";

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
] as const;

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
    } else {
      meta[field] = raw[field] ?? null;
    }
  }
  // thumbnail field will be set after download
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
  printConfig(config, overrides);

  // Find yt-dlp binary
  let ytdlp: string;
  try {
    ytdlp = await findYtDlpBinary();
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  console.log("Fetching video metadata...");
  let rawMeta: Record<string, unknown>;
  try {
    rawMeta = await fetchMetadata(ytdlp, url);
  } catch (err) {
    console.error(`Error: Failed to fetch metadata. ${(err as Error).message}`);
    process.exit(1);
  }

  const meta = buildMetadata(rawMeta);

  const channelDir = sanitize(meta.channel);
  const videoTitle = sanitize(meta.title);
  const publishedDate = formatDate(meta.upload_date);
  const videoId = meta.id;

  const folderName = `${channelDir}_${publishedDate}_${videoTitle}_[${videoId}]`;
  const videoFilename = `${channelDir}_${publishedDate}_${videoTitle}_[${videoId}]`;

  const outputDir = resolve(config.yt2pt.downloads_dir, channelDir, folderName);
  await mkdir(outputDir, { recursive: true });

  console.log(`Downloading video to ${outputDir}/...`);
  try {
    await downloadVideo(ytdlp, url, outputDir, videoFilename, config);
  } catch (err) {
    console.error(`Error: Failed to download video. ${(err as Error).message}`);
    process.exit(1);
  }

  // Determine the actual video file extension
  const files = await readdir(outputDir);
  const videoFile = files.find((f) => f.startsWith(videoFilename) && !f.endsWith(".part"));
  const actualExt = videoFile ? extname(videoFile).slice(1) : config.ytdlp.merge_output_format;
  meta.ext = actualExt;

  console.log("Downloading thumbnail...");
  try {
    const thumbFilename = await downloadThumbnail(ytdlp, url, outputDir, config);
    meta.thumbnail = thumbFilename;
  } catch (err) {
    console.error(`Warning: Failed to download thumbnail. ${(err as Error).message}`);
    meta.thumbnail = "";
  }

  // Write metadata.json
  await writeFile(join(outputDir, "metadata.json"), JSON.stringify(meta, null, 2) + "\n");

  console.log(`\nDone! Files saved to:\n  ${outputDir}/`);
  const finalFiles = await readdir(outputDir);
  for (const f of finalFiles) {
    console.log(`  - ${f}`);
  }
}

main();
