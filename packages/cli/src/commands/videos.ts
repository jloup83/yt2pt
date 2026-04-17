import type { ApiClient } from "../api/client";
import { isJsonMode, paint, printJson } from "../output/format";
import { renderVideosTable, type VideoRow } from "../output/table";

interface VideosListResponse {
  videos: VideoRow[];
  total: number;
  page: number;
  per_page: number;
}

export interface VideosFilters {
  status?: string;
  channel?: string;
  page?: number;
  perPage?: number;
}

export async function runVideosList(client: ApiClient, filters: VideosFilters = {}): Promise<number> {
  const query: Record<string, string | number | undefined> = {};
  if (filters.status) query.status = filters.status;
  if (filters.channel) query.channel = filters.channel;
  query.page = filters.page ?? 1;
  query.per_page = filters.perPage ?? 50;

  const res = await client.request<VideosListResponse>("/api/videos", { query });

  if (isJsonMode()) {
    printJson(res);
    return 0;
  }
  if (res.videos.length === 0) {
    process.stdout.write("No videos match the given filters.\n");
    return 0;
  }
  process.stdout.write(`${renderVideosTable(res.videos)}\n`);
  if (res.total > res.videos.length) {
    process.stdout.write(`\nShowing ${res.videos.length} of ${res.total} videos (page ${res.page}).\n`);
  }
  return 0;
}

// ── videos add ──────────────────────────────────────────────────────

interface VideoAddResponse {
  status: string;
  video_id: number;
  channel_id: number;
}

export async function runVideosAdd(
  client: ApiClient,
  ytUrl: string,
  ptId: string,
): Promise<number> {
  const res = await client.request<VideoAddResponse>("/api/videos", {
    method: "POST",
    body: { youtube_url: ytUrl, peertube_channel_id: ptId },
  });
  if (isJsonMode()) {
    printJson(res);
    return 0;
  }
  process.stdout.write(
    `${paint("✓", "green")} Queued video #${res.video_id} (channel #${res.channel_id}) — ${res.status}\n`,
  );
  return 0;
}

// ── videos delete ───────────────────────────────────────────────────

export interface VideosDeleteOptions {
  fromPeertube?: boolean;
  yes?: boolean;
}

interface VideoDeleteResponse {
  status: string;
  id: number;
  cancelled: boolean;
  peertube_deleted: boolean | null;
  warnings: string[];
}

export async function runVideosDelete(
  client: ApiClient,
  id: string,
  opts: VideosDeleteOptions = {},
): Promise<number> {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) {
    process.stderr.write(`Error: video id must be a positive integer\n`);
    return 1;
  }
  if (!opts.yes && !isJsonMode()) {
    const target = opts.fromPeertube ? " AND from PeerTube" : "";
    const ok = await confirm(`Delete video #${n}${target}? [y/N] `);
    if (!ok) {
      process.stdout.write("Aborted.\n");
      return 1;
    }
  }
  const query = opts.fromPeertube ? "?from_peertube=true" : "";
  const res = await client.request<VideoDeleteResponse>(
    `/api/videos/${n}${query}`,
    { method: "DELETE" },
  );
  if (isJsonMode()) {
    printJson(res);
    return 0;
  }
  process.stdout.write(
    `${paint("✓", "green")} Deleted video #${n}${res.cancelled ? " (in-flight job cancelled)" : ""}${
      res.peertube_deleted ? " — removed from PeerTube" : ""
    }\n`,
  );
  for (const w of res.warnings ?? []) {
    process.stdout.write(`  ${paint("!", "yellow")} ${w}\n`);
  }
  return 0;
}

async function confirm(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const onData = (buf: Buffer): void => {
      process.stdin.pause();
      process.stdin.off("data", onData);
      const answer = buf.toString("utf8").trim().toLowerCase();
      resolve(answer === "y" || answer === "yes");
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}
