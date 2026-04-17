import { access, readdir } from "node:fs/promises";
import { join } from "node:path";

export async function findYtDlpBinary(binDir: string): Promise<string> {
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

export function sanitize(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
}

/**
 * Return the YouTube `@handle` for a channel as found in yt-dlp's
 * `uploader_id` field, with the leading `@` stripped. Returns null if the
 * field is missing or doesn't look like a handle (e.g. a bare UCID).
 *
 * This is the canonical identifier we use for both the on-disk channel
 * folder and the PeerTube channel slug, so they stay aligned with the
 * YouTube URL the user pasted (e.g. `youtube.com/@hekima01` → `hekima01`).
 */
export function youtubeHandle(meta: Record<string, unknown>): string | null {
  const uid = meta["uploader_id"];
  if (typeof uid !== "string") return null;
  const m = /^@([A-Za-z0-9._-]+)$/.exec(uid.trim());
  return m ? m[1] : null;
}

export function formatDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/**
 * Extract the sanitized channel slug from a folder name produced by the
 * download worker: `{channel}_{YYYY-MM-DD}_{title}_[{id}]`. Returns null if
 * the folder name doesn't match.
 */
export function channelSlugFromFolderName(folderName: string): string | null {
  const m = /^(.+?)_\d{4}-\d{2}-\d{2}_/.exec(folderName);
  return m ? m[1] : null;
}

export function youtubeUrl(youtubeVideoId: string): string {
  return `https://www.youtube.com/watch?v=${youtubeVideoId}`;
}
