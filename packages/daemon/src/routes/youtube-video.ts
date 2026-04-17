import { execFile } from "node:child_process";

// ── YouTube video URL validation ────────────────────────────────────

const YT_HOSTS = new Set([
  "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
  "youtu.be",
]);

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Extract the 11-character YouTube video id from any of the common URL
 * forms (`/watch?v=…`, `youtu.be/…`, `/shorts/…`, `/live/…`, `/embed/…`).
 * Returns null when the URL does not look like a YouTube video URL.
 */
export function extractYoutubeVideoId(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (!YT_HOSTS.has(url.hostname.toLowerCase())) return null;

  // youtu.be/<id>
  if (url.hostname.toLowerCase() === "youtu.be") {
    const id = url.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
    return VIDEO_ID_RE.test(id) ? id : null;
  }

  // /watch?v=<id>
  if (url.pathname === "/watch" || url.pathname === "/watch/") {
    const v = url.searchParams.get("v") ?? "";
    return VIDEO_ID_RE.test(v) ? v : null;
  }

  // /shorts/<id>, /live/<id>, /embed/<id>, /v/<id>
  const m = /^\/(shorts|live|embed|v)\/([A-Za-z0-9_-]{11})(?:$|[/?#])/.exec(url.pathname + (url.search ? "" : ""));
  if (m) return m[2];

  return null;
}

/**
 * Normalise any YouTube video URL to `https://www.youtube.com/watch?v=<id>`.
 * Returns null when the URL is not a valid YouTube video URL.
 */
export function normalizeYoutubeVideoUrl(raw: string): string | null {
  const id = extractYoutubeVideoId(raw);
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
}

// ── yt-dlp single-video metadata resolution ─────────────────────────

export interface ResolvedYoutubeVideo {
  youtube_video_id: string;
  title: string | null;
  channel_name: string | null;
  channel_url: string | null;
}

export type VideoResolver = (url: string) => Promise<ResolvedYoutubeVideo>;

function execFileP(cmd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      cmd, args,
      { maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolvePromise(stdout);
      }
    );
  });
}

/**
 * Default implementation of `VideoResolver`: invokes yt-dlp with
 * `--dump-json --skip-download` to fetch metadata for a single video.
 */
export function makeDefaultVideoResolver(ytdlp: string): VideoResolver {
  return async (url) => {
    const stdout = await execFileP(ytdlp, ["--dump-json", "--skip-download", "--no-warnings", url]);
    const meta = JSON.parse(stdout) as Record<string, unknown>;
    const id = meta["id"];
    if (typeof id !== "string" || !VIDEO_ID_RE.test(id)) {
      throw new Error("yt-dlp did not return a valid video id");
    }
    return {
      youtube_video_id: id,
      title: typeof meta["title"] === "string" ? (meta["title"] as string) : null,
      channel_name:
        (typeof meta["channel"] === "string" && (meta["channel"] as string)) ||
        (typeof meta["uploader"] === "string" && (meta["uploader"] as string)) ||
        null,
      channel_url:
        (typeof meta["channel_url"] === "string" && (meta["channel_url"] as string)) ||
        (typeof meta["uploader_url"] === "string" && (meta["uploader_url"] as string)) ||
        null,
    };
  };
}
