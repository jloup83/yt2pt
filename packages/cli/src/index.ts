#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig, printConfig, createLogger } from "@yt2pt/shared";
import { downloadFromYouTube, convertMetadata, uploadToPeertube } from "@yt2pt/daemon";

const { version: VERSION } = JSON.parse(
  readFileSync(resolve(__dirname, "..", "package.json"), "utf-8")
);

const HELP = `yt2pt v${VERSION} — Download YouTube videos and upload to PeerTube

Usage:
  yt2pt <youtube-url>                 Download video from YouTube
  yt2pt <youtube-url> --download-only Download video from YouTube
  yt2pt --convert-metadata            Convert all downloaded metadata for PeerTube
  yt2pt --upload-only                 Upload all converted videos to PeerTube
  yt2pt <youtube-url> --upload-only   Upload a specific video to PeerTube
  yt2pt -h, --help                    Show this help
  yt2pt -v, --version                 Show version

Examples:
  yt2pt https://www.youtube.com/watch?v=q5Mq4kEa7pA
  yt2pt https://youtu.be/q5Mq4kEa7pA
`;

function isYouTubeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /^(www\.)?(youtube\.com|youtu\.be|m\.youtube\.com|music\.youtube\.com)$/.test(parsed.hostname);
  } catch {
    return false;
  }
}

async function findYtDlpBinary(): Promise<string> {
  // From packages/cli/dist/ back up to repo root bin/
  const binDir = resolve(__dirname, "..", "..", "..", "bin");
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

  const flags = args.filter((a) => a.startsWith("--"));
  const positional = args.filter((a) => !a.startsWith("-"));
  const url = positional[0];

  const hasDownloadOnly = flags.includes("--download-only");
  const hasConvertMetadata = flags.includes("--convert-metadata");
  const hasUploadOnly = flags.includes("--upload-only");

  // Load and display configuration
  const { config, overrides } = loadConfig();
  const log = createLogger(config);
  printConfig(config, overrides, log);

  // ── Convert metadata ──────────────────────────────────────────────
  if (hasConvertMetadata) {
    await convertMetadata(config, log);
    process.exit(0);
  }

  // ── Upload only ───────────────────────────────────────────────────
  if (hasUploadOnly) {
    await uploadToPeertube(config, log);
    process.exit(0);
  }

  // ── Download (default) ────────────────────────────────────────────
  if (!url) {
    console.error("Error: A YouTube URL is required for download mode");
    process.exit(1);
  }

  if (!isYouTubeUrl(url)) {
    console.error(`Error: Invalid YouTube URL: ${url}`);
    process.exit(1);
  }

  let ytdlp: string;
  try {
    ytdlp = await findYtDlpBinary();
    log.debug(`yt-dlp binary: ${ytdlp}`);
  } catch (err) {
    log.error(`${(err as Error).message}`);
    process.exit(1);
  }

  await downloadFromYouTube(ytdlp, url, config, log);
}

main();
