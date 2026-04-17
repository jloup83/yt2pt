import type { ApiClient } from "../api/client";
import { openEventStream, parseSseData } from "../api/sse";
import { isJsonMode, paint, padRight, printJson } from "../output/format";
import {
  makeEmptySnapshot,
  SyncProgressRenderer,
  type SyncSnapshot,
} from "../output/progress";

// ── Types (mirror the daemon response shapes) ───────────────────────

export interface ChannelSummary {
  id: number;
  youtube_channel_url: string;
  youtube_channel_name: string | null;
  peertube_channel_id: string;
  added_at: string;
  last_synced_at: string | null;
  video_count: number;
  status_summary: Record<string, number>;
}

interface ChannelsListResponse {
  channels: ChannelSummary[];
}

// ── Commands ────────────────────────────────────────────────────────

export async function runChannelsList(client: ApiClient): Promise<number> {
  const { channels } = await client.request<ChannelsListResponse>("/api/channels");
  if (isJsonMode()) {
    printJson(channels);
    return 0;
  }
  if (channels.length === 0) {
    process.stdout.write("No channels mapped.\n");
    return 0;
  }
  process.stdout.write(`${formatChannels(channels)}\n`);
  return 0;
}

export async function runChannelsAdd(client: ApiClient, ytUrl: string, ptId: string): Promise<number> {
  const ch = await client.request<ChannelSummary>("/api/channels", {
    method: "POST",
    body: { youtube_channel_url: ytUrl, peertube_channel_id: ptId },
  });
  if (isJsonMode()) {
    printJson(ch);
    return 0;
  }
  const name = ch.youtube_channel_name ?? ch.youtube_channel_url;
  process.stdout.write(
    `${paint("✓", "green")} Added channel #${ch.id}  ${name} → PeerTube channel ${ch.peertube_channel_id}\n`,
  );
  return 0;
}

export interface ChannelsRemoveOptions {
  fromPeertube?: boolean;
  yes?: boolean;
}

export async function runChannelsRemove(
  client: ApiClient,
  id: string,
  opts: ChannelsRemoveOptions = {},
): Promise<number> {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) {
    process.stderr.write(`Error: channel id must be a positive integer\n`);
    return 1;
  }
  if (!opts.yes && !isJsonMode()) {
    const target = opts.fromPeertube ? " AND delete its videos from PeerTube" : "";
    const ok = await confirm(
      `Remove channel #${n} and all its tracked videos${target}? [y/N] `,
    );
    if (!ok) {
      process.stdout.write("Aborted.\n");
      return 1;
    }
  }
  const query = opts.fromPeertube ? "?from_peertube=true" : "";
  const res = await client.request<{
    status?: string;
    videos_deleted?: number;
    warnings?: string[];
  }>(`/api/channels/${n}${query}`, { method: "DELETE" });
  if (isJsonMode()) {
    printJson({ ok: true, id: n, ...res });
    return 0;
  }
  const count = res?.videos_deleted ?? 0;
  process.stdout.write(
    `${paint("✓", "green")} Removed channel #${n} (${count} video${count === 1 ? "" : "s"} deleted)\n`,
  );
  for (const w of res?.warnings ?? []) {
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

// ── Sync (with live progress from SSE) ──────────────────────────────

interface SyncTriggerResponse {
  status: string;
  channel_id: number;
  retry_after_s?: number;
}

interface SyncStartedEvent {
  channel_id: number;
  youtube_channel_url: string;
}

interface SyncProgressEvent {
  channel_id: number;
  new_videos: number;
  already_tracked: number;
}

interface SyncCompleteEvent {
  channel_id: number;
  new_videos: number;
  already_tracked: number;
  skipped: number;
}

interface SyncFailedEvent {
  channel_id: number;
  error: string;
}

interface VideoStatusEvent {
  id: number;
  status: string;
  progress_pct: number;
  updated_at: string;
  error_message: string | null;
}

interface VideosPage {
  videos: Array<{
    id: number;
    channel_id: number;
    title: string | null;
    status: string;
    progress_pct: number;
  }>;
  total: number;
}

interface RunSyncOptions {
  watch?: boolean;
}

export async function runChannelsSync(
  client: ApiClient,
  idArg: string,
  opts: RunSyncOptions = {},
): Promise<number> {
  const id = Number(idArg);
  if (!Number.isInteger(id) || id <= 0) {
    process.stderr.write(`Error: channel id must be a positive integer\n`);
    return 1;
  }

  // Open the SSE stream *before* triggering, so we don't miss the
  // immediate sync-started event the daemon emits.
  const abort = new AbortController();
  const watch = opts.watch !== false;

  // Fetch the channel summary up front — useful for both JSON and human output.
  const { channels } = await client.request<ChannelsListResponse>("/api/channels");
  const channel = channels.find((c) => c.id === id);
  if (!channel) {
    process.stderr.write(`Error: no channel mapped with id ${id}\n`);
    return 1;
  }

  let eventStream: ReturnType<typeof openEventStream> | null = null;
  if (watch) {
    eventStream = openEventStream(client, abort.signal);
  }

  const trigger = await client.request<SyncTriggerResponse>(`/api/channels/${id}/sync`, {
    method: "POST",
  });

  if (trigger.status !== "started") {
    abort.abort();
    if (isJsonMode()) {
      printJson(trigger);
      return 1;
    }
    process.stderr.write(`Sync not started: ${trigger.status}\n`);
    return 1;
  }

  if (!watch || !eventStream) {
    if (isJsonMode()) {
      printJson(trigger);
      return 0;
    }
    process.stdout.write(`${paint("✓", "green")} Sync started for channel #${id}\n`);
    return 0;
  }

  // ── Live progress display ────────────────────────────────────────
  const name = channel.youtube_channel_name ?? channel.youtube_channel_url;
  const snap: SyncSnapshot = makeEmptySnapshot(name);
  const renderer = new SyncProgressRenderer();
  // Seed phase totals from the current video counts so existing work is reflected.
  await seedCounts(client, id, snap);
  renderer.render(snap);

  let exitCode = 0;
  try {
    for await (const msg of eventStream) {
      if (msg.event === "sync_started") {
        const _ev = parseSseData<SyncStartedEvent>(msg);
        if (typeof _ev === "object" && (_ev as SyncStartedEvent).channel_id !== id) continue;
      } else if (msg.event === "sync_progress") {
        const ev = parseSseData<SyncProgressEvent>(msg);
        if (typeof ev !== "object" || (ev as SyncProgressEvent).channel_id !== id) continue;
        snap.discovered = (ev as SyncProgressEvent).new_videos + (ev as SyncProgressEvent).already_tracked;
        snap.new_videos = (ev as SyncProgressEvent).new_videos;
        snap.already_tracked = (ev as SyncProgressEvent).already_tracked;
        await seedCounts(client, id, snap);
        renderer.render(snap);
      } else if (msg.event === "video_status") {
        const ev = parseSseData<VideoStatusEvent>(msg);
        if (typeof ev !== "object") continue;
        applyVideoStatus(snap, ev as VideoStatusEvent);
        renderer.render(snap);
      } else if (msg.event === "sync_complete") {
        const ev = parseSseData<SyncCompleteEvent>(msg);
        if (typeof ev !== "object" || (ev as SyncCompleteEvent).channel_id !== id) continue;
        const done = ev as SyncCompleteEvent;
        snap.new_videos = done.new_videos;
        snap.already_tracked = done.already_tracked;
        snap.discovered = done.new_videos + done.already_tracked;
        renderer.render(snap);
        renderer.clear();
        process.stdout.write(
          `${paint("✓", "green")} Sync complete: ${done.new_videos} new, ${done.already_tracked} already tracked` +
          (done.skipped ? `, ${done.skipped} skipped` : "") + "\n",
        );
        break;
      } else if (msg.event === "sync_failed") {
        const ev = parseSseData<SyncFailedEvent>(msg);
        if (typeof ev !== "object" || (ev as SyncFailedEvent).channel_id !== id) continue;
        renderer.clear();
        process.stderr.write(`${paint("✗", "red")} Sync failed: ${(ev as SyncFailedEvent).error}\n`);
        exitCode = 1;
        break;
      }
    }
  } finally {
    abort.abort();
  }

  return exitCode;
}

// ── Progress helpers ────────────────────────────────────────────────

/** Populate phase done/total counts from the DB. */
async function seedCounts(client: ApiClient, channelId: number, snap: SyncSnapshot): Promise<void> {
  try {
    const page = await client.request<VideosPage>("/api/videos", {
      query: { channel: channelId, per_page: 200 },
    });
    const dl = { done: 0, total: 0, current: null as string | null };
    const cv = { done: 0, total: 0, current: null as string | null };
    const up = { done: 0, total: 0, current: null as string | null };

    for (const v of page.videos) {
      if (v.status.startsWith("DOWNLOAD") || ["CONVERT_QUEUED", "CONVERTING", "CONVERT_FAILED",
        "UPLOAD_QUEUED", "UPLOADING", "UPLOAD_FAILED", "UPLOADED"].includes(v.status)) {
        dl.total += 1;
        if (v.status !== "DOWNLOAD_QUEUED" && v.status !== "DOWNLOADING") dl.done += 1;
        if (v.status === "DOWNLOADING" && !dl.current) dl.current = v.title ?? null;
      }
      if (["CONVERT_QUEUED", "CONVERTING", "CONVERT_FAILED",
        "UPLOAD_QUEUED", "UPLOADING", "UPLOAD_FAILED", "UPLOADED"].includes(v.status)) {
        cv.total += 1;
        if (!["CONVERT_QUEUED", "CONVERTING"].includes(v.status)) cv.done += 1;
        if (v.status === "CONVERTING" && !cv.current) cv.current = v.title ?? null;
      }
      if (["UPLOAD_QUEUED", "UPLOADING", "UPLOAD_FAILED", "UPLOADED"].includes(v.status)) {
        up.total += 1;
        if (v.status === "UPLOADED") up.done += 1;
        if (v.status === "UPLOADING" && !up.current) up.current = v.title ?? null;
      }
    }
    snap.downloading = dl;
    snap.converting = cv;
    snap.uploading = up;
  } catch {
    // Non-fatal: we keep the previous snapshot on transient errors.
  }
}

/** Apply a single video_status event to the snapshot counters. */
function applyVideoStatus(snap: SyncSnapshot, ev: VideoStatusEvent): void {
  // These heuristics assume seeding has established totals; individual
  // events move the "current" label and let the next seedCounts (driven
  // by sync_progress) reconcile authoritatively.
  if (ev.status === "DOWNLOADING") snap.downloading.current = `#${ev.id}`;
  else if (ev.status === "CONVERTING") snap.converting.current = `#${ev.id}`;
  else if (ev.status === "UPLOADING") snap.uploading.current = `#${ev.id}`;
}

// ── Channel list formatting ─────────────────────────────────────────

function formatChannels(channels: ChannelSummary[]): string {
  const idW = Math.max(2, ...channels.map((c) => String(c.id).length));
  const nameW = Math.max(7,
    ...channels.map((c) => (c.youtube_channel_name ?? "—").length));
  const ptW = Math.max(10, ...channels.map((c) => c.peertube_channel_id.length));

  const lines: string[] = [];
  lines.push(`${padRight("ID", idW)}  ${padRight("YouTube", nameW)}  ${padRight("PeerTube", ptW)}  Videos`);
  lines.push(`${"─".repeat(idW)}  ${"─".repeat(nameW)}  ${"─".repeat(ptW)}  ──────`);
  for (const c of channels) {
    const name = c.youtube_channel_name ?? "—";
    const summary = Object.entries(c.status_summary)
      .map(([s, n]) => `${s}:${n}`).join(" ");
    lines.push(
      `${padRight(String(c.id), idW)}  ${padRight(name, nameW)}  ${padRight(c.peertube_channel_id, ptW)}  ${c.video_count}${summary ? "  " + paint(summary, "gray") : ""}`,
    );
  }
  return lines.join("\n");
}
