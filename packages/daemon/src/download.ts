import { execFile } from "node:child_process";
import { mkdir, writeFile, readdir, rmdir } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { Config, Logger } from "@yt2pt/shared";

// ── Helpers ─────────────────────────────────────────────────────────

function sanitize(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
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

// ── Download functions ──────────────────────────────────────────────

async function fetchMetadata(ytdlp: string, url: string): Promise<Record<string, unknown>> {
  const { stdout } = await run(ytdlp, ["--dump-json", "--skip-download", url]);
  return JSON.parse(stdout) as Record<string, unknown>;
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
  const subtitlesDir = join(outputDir, "subtitles");
  await mkdir(subtitlesDir, { recursive: true });

  await run(ytdlp, [
    "--skip-download",
    "--write-subs",
    "--sub-format", "vtt",
    "-o", join(subtitlesDir, "%(id)s"),
    url,
  ]);

  const entries = await readdir(subtitlesDir);
  const vttFiles = entries.filter((f) => f.endsWith(".vtt"));

  if (vttFiles.length === 0) {
    await rmdir(subtitlesDir).catch(() => {});
  }

  return vttFiles;
}

async function downloadThumbnail(
  ytdlp: string,
  url: string,
  outputDir: string,
  config: Config
): Promise<string> {
  await run(ytdlp, [
    "--skip-download",
    "--write-thumbnail",
    "--convert-thumbnails",
    config.ytdlp.thumbnail_format,
    "-o",
    join(outputDir, "thumbnail"),
    url,
  ]);

  const entries = await readdir(outputDir);
  const thumb = entries.find((f) => f.startsWith("thumbnail") && f !== "thumbnail" && !f.endsWith(".part"));
  if (!thumb) {
    throw new Error("Failed to download thumbnail");
  }
  return thumb;
}

// ── Main download entry point ───────────────────────────────────────

export async function downloadFromYouTube(
  ytdlp: string,
  url: string,
  config: Config,
  log: Logger
): Promise<void> {
  log.info("Fetching video metadata...");
  let rawMeta: Record<string, unknown>;
  try {
    rawMeta = await fetchMetadata(ytdlp, url);
    log.debug(`Raw metadata keys: ${Object.keys(rawMeta).join(", ")}`);
  } catch (err) {
    log.error(`Failed to fetch metadata. ${(err as Error).message}`);
    process.exit(1);
  }

  const channel = sanitize(rawMeta["channel"] as string);
  const title = sanitize(rawMeta["title"] as string);
  const publishedDate = formatDate(rawMeta["upload_date"] as string);
  const videoId = rawMeta["id"] as string;

  const folderName = `${channel}_${publishedDate}_${title}_[${videoId}]`;
  const videoFilename = `${channel}_${publishedDate}_${title}_[${videoId}]`;

  const outputDir = resolve(config.yt2pt.data_dir, "downloaded_from_youtube", channel, folderName);
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

  // Determine the actual video file extension for metadata
  const files = await readdir(outputDir);
  const videoFile = files.find((f) => f.startsWith(videoFilename) && !f.endsWith(".part"));
  const actualExt = videoFile ? extname(videoFile).slice(1) : config.ytdlp.merge_output_format;
  rawMeta["_ext"] = actualExt;

  log.info("Downloading thumbnail...");
  try {
    const thumbFilename = await downloadThumbnail(ytdlp, url, outputDir, config);
    rawMeta["_thumbnail_file"] = thumbFilename;
    log.debug(`Thumbnail saved: ${thumbFilename}`);
  } catch (err) {
    log.error(`Failed to download thumbnail. ${(err as Error).message}`);
  }

  log.info("Downloading subtitles...");
  try {
    const subtitleFiles = await downloadCaptions(ytdlp, url, outputDir);
    rawMeta["_subtitle_files"] = subtitleFiles;
    if (subtitleFiles.length > 0) {
      log.info(`Downloaded ${subtitleFiles.length} subtitle(s)`);
      for (const f of subtitleFiles) {
        log.debug(`  - subtitles/${f}`);
      }
    } else {
      log.info("No subtitles available");
    }
  } catch (err) {
    log.error(`Failed to download subtitles. ${(err as Error).message}`);
  }

  // Write full raw yt-dlp metadata as metadata.json
  await writeFile(join(outputDir, "metadata.json"), JSON.stringify(rawMeta, null, 2) + "\n");
  log.debug("metadata.json written");

  log.info(`Done! Files saved to: ${outputDir}/`);
  const finalFiles = await readdir(outputDir);
  for (const f of finalFiles) {
    log.info(`  - ${f}`);
  }
}
