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
