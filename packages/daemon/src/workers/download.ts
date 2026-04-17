import { execFile } from "node:child_process";
import { mkdir, writeFile, readdir, rmdir } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import type { Config, Logger, ResolvedPaths } from "@yt2pt/shared";
import { sanitize, formatDate } from "./paths";

export interface DownloadResult {
  folderName: string;
  channelSlug: string;
  outputDir: string;
}

function run(
  cmd: string,
  args: string[],
  signal?: AbortSignal,
  log?: Logger,
): Promise<{ stdout: string; stderr: string }> {
  log?.debug(`$ ${shellQuote(cmd, args)}`);
  return new Promise((resolvePromise, reject) => {
    const child = execFile(cmd, args, { maxBuffer: 50 * 1024 * 1024, signal }, (error, stdout, stderr) => {
      if (error) {
        if ((error as NodeJS.ErrnoException).code === "ABORT_ERR") {
          reject(new Error("aborted"));
        } else {
          reject(new Error(`${cmd} failed: ${stderr || error.message}`));
        }
      } else {
        resolvePromise({ stdout, stderr });
      }
    });
    if (signal) {
      signal.addEventListener("abort", () => { try { child.kill("SIGTERM"); } catch { /* noop */ } }, { once: true });
    }
  });
}

function shellQuote(cmd: string, args: string[]): string {
  const q = (s: string): string =>
    /^[A-Za-z0-9_./:@=+,-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
  return [cmd, ...args].map(q).join(" ");
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("aborted");
}

/**
 * Download one video + its thumbnail + subtitles + write metadata.json.
 * Throws on failure. Returns the resolved paths and folder name.
 */
export async function runDownload(
  ytdlp: string,
  url: string,
  config: Config,
  paths: ResolvedPaths,
  log: Logger,
  signal?: AbortSignal,
  onProgress?: (pct: number) => void
): Promise<DownloadResult> {
  checkAborted(signal);

  log.info("Fetching video metadata...");
  const { stdout } = await run(ytdlp, ["--dump-json", "--skip-download", url], signal, log);
  const rawMeta = JSON.parse(stdout) as Record<string, unknown>;
  onProgress?.(10);

  const channel = sanitize(rawMeta["channel"] as string);
  const title = sanitize(rawMeta["title"] as string);
  const publishedDate = formatDate(rawMeta["upload_date"] as string);
  const videoId = rawMeta["id"] as string;

  const folderName = `${channel}_${publishedDate}_${title}_[${videoId}]`;
  const videoFilename = folderName;

  const outputDir = resolve(paths.dataDir, "downloaded_from_youtube", channel, folderName);
  await mkdir(outputDir, { recursive: true });
  log.debug(`Output directory: ${outputDir}`);

  checkAborted(signal);

  log.info(`Downloading video to ${outputDir}/...`);
  await run(ytdlp, [
    "-f", config.ytdlp.format,
    "--merge-output-format", config.ytdlp.merge_output_format,
    "-o", join(outputDir, videoFilename),
    url,
  ], signal, log);
  onProgress?.(70);

  // Determine the actual video file extension
  const files = await readdir(outputDir);
  const videoFile = files.find((f) => f.startsWith(videoFilename) && !f.endsWith(".part"));
  const actualExt = videoFile ? extname(videoFile).slice(1) : config.ytdlp.merge_output_format;
  rawMeta["_ext"] = actualExt;

  checkAborted(signal);

  // Thumbnail
  log.info("Downloading thumbnail...");
  try {
    await run(ytdlp, [
      "--skip-download", "--write-thumbnail",
      "--convert-thumbnails", config.ytdlp.thumbnail_format,
      "-o", join(outputDir, "thumbnail"),
      url,
    ], signal, log);
    const entries = await readdir(outputDir);
    const thumb = entries.find((f) => f.startsWith("thumbnail") && f !== "thumbnail" && !f.endsWith(".part"));
    if (thumb) rawMeta["_thumbnail_file"] = thumb;
  } catch (err) {
    log.error(`Thumbnail download failed: ${(err as Error).message}`);
  }
  onProgress?.(85);

  checkAborted(signal);

  // Subtitles
  log.info("Downloading subtitles...");
  try {
    const subtitlesDir = join(outputDir, "subtitles");
    await mkdir(subtitlesDir, { recursive: true });
    await run(ytdlp, [
      "--skip-download", "--write-subs",
      "--sub-format", "vtt",
      "-o", join(subtitlesDir, "%(id)s"),
      url,
    ], signal, log);
    const entries = await readdir(subtitlesDir);
    const vttFiles = entries.filter((f) => f.endsWith(".vtt"));
    if (vttFiles.length === 0) {
      await rmdir(subtitlesDir).catch(() => {});
    } else {
      rawMeta["_subtitle_files"] = vttFiles;
      log.info(`Downloaded ${vttFiles.length} subtitle(s)`);
    }
  } catch (err) {
    log.error(`Subtitle download failed: ${(err as Error).message}`);
  }
  onProgress?.(95);

  await writeFile(join(outputDir, "metadata.json"), JSON.stringify(rawMeta, null, 2) + "\n");
  log.debug("metadata.json written");

  log.info(`Download complete: ${outputDir}/`);
  return { folderName, channelSlug: channel, outputDir };
}
