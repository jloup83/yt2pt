import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Logger } from "@yt2pt/shared";
import { sanitize } from "../workers/paths";

/**
 * Structured result for a single channel-info fetch.
 */
export interface ChannelInfo {
  slug: string;
  dir: string;
  metadataPath: string;
  avatarPath: string | null;
  bannerPath: string | null;
}

export interface FetchChannelInfoOptions {
  ytdlp: string;
  channelUrl: string;
  dataDir: string;
  logger: Logger;
  signal?: AbortSignal;
  /** Override yt-dlp invocation (tests). Returns stdout. */
  runYtdlp?: (binary: string, args: string[], signal?: AbortSignal) => Promise<string>;
  /** Override image downloader (tests). */
  downloadImage?: (url: string, dest: string, signal?: AbortSignal) => Promise<void>;
}

/**
 * Raw yt-dlp thumbnail entry (subset we care about).
 */
interface ThumbnailEntry {
  id?: string;
  url?: string;
  width?: number;
  height?: number;
  preference?: number;
}

const IMAGE_EXT = /\.(jpe?g|png|webp|gif)(\?|$)/i;

/**
 * Fetch channel-level info from YouTube via yt-dlp and persist it on disk.
 *
 * Writes, under `<dataDir>/downloaded_from_youtube/<slug>/channel_info/`:
 *
 *   - `metadata.json`   full yt-dlp channel JSON (verbatim)
 *   - `avatar.<ext>`    highest-resolution channel avatar (if available)
 *   - `banner.<ext>`    highest-resolution channel banner (if available)
 *
 * Idempotent: overwrites existing files on each call.
 *
 * Failures to download individual images are non-fatal (logged as warnings);
 * failure to run yt-dlp at all throws.
 */
export async function fetchChannelInfo(opts: FetchChannelInfoOptions): Promise<ChannelInfo> {
  const runYt = opts.runYtdlp ?? defaultRunYtdlp;
  const dlImage = opts.downloadImage ?? defaultDownloadImage;

  opts.logger.info(`Fetching channel info: ${opts.channelUrl}`);

  const stdout = await runYt(
    opts.ytdlp,
    [
      "--dump-single-json",
      "--flat-playlist",
      "--playlist-items", "0",
      "--no-warnings",
      opts.channelUrl,
    ],
    opts.signal
  );

  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(stdout) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`failed to parse yt-dlp channel JSON: ${(err as Error).message}`);
  }

  const name = (meta["channel"] as string | undefined)
    ?? (meta["uploader"] as string | undefined)
    ?? (meta["title"] as string | undefined);
  if (!name) {
    throw new Error("yt-dlp channel JSON did not include channel/uploader/title");
  }
  const slug = sanitize(name);
  if (!slug) {
    throw new Error(`could not derive a non-empty slug from channel name "${name}"`);
  }

  const dir = resolve(opts.dataDir, "downloaded_from_youtube", slug, "channel_info");
  await mkdir(dir, { recursive: true });

  const metadataPath = join(dir, "metadata.json");
  await writeFile(metadataPath, JSON.stringify(meta, null, 2), "utf-8");
  opts.logger.debug(`Wrote ${metadataPath}`);

  const thumbnails = Array.isArray(meta["thumbnails"])
    ? (meta["thumbnails"] as ThumbnailEntry[])
    : [];

  const avatarUrl = pickAvatar(thumbnails);
  const bannerUrl = pickBanner(thumbnails);

  let avatarPath: string | null = null;
  if (avatarUrl) {
    const ext = imageExtFromUrl(avatarUrl) ?? "jpg";
    const target = join(dir, `avatar.${ext}`);
    try {
      await dlImage(avatarUrl, target, opts.signal);
      avatarPath = target;
      opts.logger.debug(`Wrote ${target}`);
    } catch (err) {
      opts.logger.error(
        `channel avatar download failed (${avatarUrl}): ${(err as Error).message}`
      );
    }
  } else {
    opts.logger.debug("No channel avatar thumbnail available");
  }

  let bannerPath: string | null = null;
  if (bannerUrl) {
    const ext = imageExtFromUrl(bannerUrl) ?? "jpg";
    const target = join(dir, `banner.${ext}`);
    try {
      await dlImage(bannerUrl, target, opts.signal);
      bannerPath = target;
      opts.logger.debug(`Wrote ${target}`);
    } catch (err) {
      opts.logger.error(
        `channel banner download failed (${bannerUrl}): ${(err as Error).message}`
      );
    }
  } else {
    opts.logger.debug("No channel banner thumbnail available");
  }

  return { slug, dir, metadataPath, avatarPath, bannerPath };
}

// ── Thumbnail selection ─────────────────────────────────────────────

/** Ids yt-dlp uses for YouTube channel avatars, preferred first. */
const AVATAR_IDS = ["avatar_uncropped", "avatars"];
/** Ids yt-dlp uses for YouTube channel banners, preferred first. */
const BANNER_IDS = ["banner_uncropped", "banner"];

/** Generic fallback hints. Avatars tend to be square; banners very wide. */
function looksLikeAvatar(t: ThumbnailEntry): boolean {
  const id = (t.id ?? "").toLowerCase();
  if (id.includes("avatar")) return true;
  const { width, height } = t;
  return typeof width === "number" && typeof height === "number"
    && width === height && width >= 48;
}

function looksLikeBanner(t: ThumbnailEntry): boolean {
  const id = (t.id ?? "").toLowerCase();
  if (id.includes("banner")) return true;
  const { width, height } = t;
  return typeof width === "number" && typeof height === "number"
    && width > height * 2 && width >= 512;
}

function pickByPreferredIds(
  thumbs: ThumbnailEntry[],
  preferredIds: string[]
): string | null {
  for (const id of preferredIds) {
    const matches = thumbs.filter((t) => t.id === id && typeof t.url === "string");
    if (matches.length > 0) {
      return largest(matches)?.url ?? null;
    }
  }
  return null;
}

function largest(thumbs: ThumbnailEntry[]): ThumbnailEntry | null {
  let best: ThumbnailEntry | null = null;
  let bestArea = -1;
  for (const t of thumbs) {
    const area = (t.width ?? 0) * (t.height ?? 0);
    if (area > bestArea) {
      bestArea = area;
      best = t;
    }
  }
  return best;
}

export function pickAvatar(thumbs: ThumbnailEntry[]): string | null {
  const byId = pickByPreferredIds(thumbs, AVATAR_IDS);
  if (byId) return byId;
  const candidates = thumbs.filter((t) => typeof t.url === "string" && looksLikeAvatar(t));
  return largest(candidates)?.url ?? null;
}

export function pickBanner(thumbs: ThumbnailEntry[]): string | null {
  const byId = pickByPreferredIds(thumbs, BANNER_IDS);
  if (byId) return byId;
  const candidates = thumbs.filter((t) => typeof t.url === "string" && looksLikeBanner(t));
  return largest(candidates)?.url ?? null;
}

export function imageExtFromUrl(url: string): string | null {
  const m = IMAGE_EXT.exec(url);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  return ext === "jpeg" ? "jpg" : ext;
}

// ── Default implementations ─────────────────────────────────────────

function defaultRunYtdlp(
  binary: string,
  args: string[],
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      binary,
      args,
      { maxBuffer: 50 * 1024 * 1024, signal },
      (error, stdout, stderr) => {
        if (error) {
          if ((error as NodeJS.ErrnoException).code === "ABORT_ERR") {
            reject(new Error("aborted"));
          } else {
            reject(new Error(`${binary} failed: ${stderr || error.message}`));
          }
        } else {
          resolvePromise(stdout);
        }
      }
    );
    if (signal) {
      signal.addEventListener(
        "abort",
        () => { try { child.kill("SIGTERM"); } catch { /* noop */ } },
        { once: true }
      );
    }
  });
}

async function defaultDownloadImage(
  url: string,
  dest: string,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  if (!response.body) {
    throw new Error("response has no body");
  }
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(dest));
}
