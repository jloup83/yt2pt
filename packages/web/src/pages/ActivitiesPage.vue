<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import {
  endpoints,
  type ChannelSummary,
  type VideoRow,
} from "../api";
import { useEvents, type VideoStatusEvent } from "../composables/useEvents";

// Keep in sync with packages/daemon/src/db/schema.ts
const STATUSES = [
  "DOWNLOAD_QUEUED", "DOWNLOADING", "DOWNLOAD_FAILED",
  "CONVERT_QUEUED", "CONVERTING", "CONVERT_FAILED",
  "UPLOAD_QUEUED", "UPLOADING", "UPLOAD_FAILED",
  "UPLOADED",
] as const;
type Status = typeof STATUSES[number];

const ACTIVE: ReadonlySet<Status> = new Set(["DOWNLOADING", "CONVERTING", "UPLOADING"]);
const FAILED: ReadonlySet<Status> = new Set(["DOWNLOAD_FAILED", "CONVERT_FAILED", "UPLOAD_FAILED"]);

type Stage = "download" | "convert" | "upload";
const STAGE_OF: Record<Status, Stage> = {
  DOWNLOAD_QUEUED: "download", DOWNLOADING: "download", DOWNLOAD_FAILED: "download",
  CONVERT_QUEUED: "convert", CONVERTING: "convert", CONVERT_FAILED: "convert",
  UPLOAD_QUEUED: "upload", UPLOADING: "upload", UPLOAD_FAILED: "upload", UPLOADED: "upload",
};

// ── State ─────────────────────────────────────────────────────────
const videos = ref<VideoRow[]>([]);
const channels = ref<ChannelSummary[]>([]);
const loading = ref(true);
const err = ref<string | null>(null);

// Per-channel page navigation: each expanded channel shows CHANNEL_PAGE_SIZE
// videos at a time with page buttons (1, 2, 3…) at the bottom.
const CHANNEL_PAGE_SIZE = 100;
const channelPage = reactive<Record<number, number>>({});

const channelFilter = ref<string>("");
const statusFilter = ref<Status[]>([]);
const flashes = ref<Record<number, number>>({});

// Expand/collapse state, persisted in localStorage and keyed by channel id.
// Default is collapsed for every channel.
const EXPAND_KEY = "yt2pt.activities.expanded.v1";
const expanded = reactive<Record<number, boolean>>(loadExpanded());

function loadExpanded(): Record<number, boolean> {
  try {
    const raw = localStorage.getItem(EXPAND_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<number, boolean> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        const n = Number(k);
        if (Number.isInteger(n) && typeof v === "boolean") out[n] = v;
      }
      return out;
    }
  } catch {
    // fall through
  }
  return {};
}

function persistExpanded(): void {
  try {
    localStorage.setItem(EXPAND_KEY, JSON.stringify(expanded));
  } catch {
    // localStorage unavailable — swallow
  }
}

function isExpanded(channelId: number): boolean {
  // When a single channel is filtered, force-expand it so filtering is useful.
  if (channelFilter.value && String(channelId) === channelFilter.value) return true;
  return !!expanded[channelId];
}

function toggleExpanded(channelId: number): void {
  expanded[channelId] = !expanded[channelId];
  if (!expanded[channelId]) delete expanded[channelId];
  persistExpanded();
}

// Relative timestamps refresh tick
const now = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | null = null;

// ── Fetch ─────────────────────────────────────────────────────────
async function load(): Promise<void> {
  loading.value = true;
  err.value = null;
  try {
    const params = new URLSearchParams();
    if (channelFilter.value) params.set("channel", channelFilter.value);
    if (statusFilter.value.length > 0) params.set("status", statusFilter.value.join(","));
    // Load all videos — per-channel pagination is handled in the template.
    params.set("per_page", "100000");
    params.set("sort", "upload_date");
    params.set("order", "desc");
    const res = await endpoints.listVideos(params);
    videos.value = res.videos;
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

function currentChannelPage(channelId: number): number {
  return channelPage[channelId] ?? 1;
}

function channelPageCount(totalVideos: number): number {
  return Math.max(1, Math.ceil(totalVideos / CHANNEL_PAGE_SIZE));
}

function pageVideos(videos: VideoRow[], channelId: number): VideoRow[] {
  const page = currentChannelPage(channelId);
  const start = (page - 1) * CHANNEL_PAGE_SIZE;
  return videos.slice(start, start + CHANNEL_PAGE_SIZE);
}

function setChannelPage(channelId: number, page: number): void {
  channelPage[channelId] = page;
}

async function loadChannels(): Promise<void> {
  try {
    const res = await endpoints.listChannels();
    channels.value = res.channels;
  } catch {
    // Filter dropdown is optional.
  }
}

// ── Grouping ──────────────────────────────────────────────────────
interface ChannelGroup {
  channel: ChannelSummary;
  videos: VideoRow[];
  statusCounts: Record<string, number>;
  total: number;
}

/**
 * Group the currently-loaded videos by channel. We drive the list from
 * `channels` (not just videos present) so that freshly-created but
 * not-yet-synced channels still appear with an empty body.
 *
 * Applies the channel filter client-side too (server already filters
 * videos, but we also need to hide whole channel headers).
 */
const groups = computed<ChannelGroup[]>(() => {
  const byId = new Map<number, VideoRow[]>();
  for (const v of videos.value) {
    const arr = byId.get(v.channel_id) ?? [];
    arr.push(v);
    byId.set(v.channel_id, arr);
  }

  const filterId = channelFilter.value ? Number(channelFilter.value) : null;

  const out: ChannelGroup[] = [];
  for (const c of channels.value) {
    if (filterId !== null && c.id !== filterId) continue;
    const vids = (byId.get(c.id) ?? []).slice().sort(compareByUploadDateDesc);
    const statusCounts: Record<string, number> = {};
    for (const v of vids) statusCounts[v.status] = (statusCounts[v.status] ?? 0) + 1;
    // When a status filter is active, hide channel blocks with no
    // matching videos (unless channel filter already pins this channel).
    if (statusFilter.value.length > 0 && vids.length === 0 && filterId === null) continue;
    out.push({ channel: c, videos: vids, statusCounts, total: vids.length });
  }
  return out;
});

function compareByUploadDateDesc(a: VideoRow, b: VideoRow): number {
  const au = a.upload_date ?? "";
  const bu = b.upload_date ?? "";
  if (au !== bu) return au > bu ? -1 : 1;
  // Secondary: more recently added first.
  return b.id - a.id;
}

// ── Pipeline helpers ──────────────────────────────────────────────
function truncate(s: string | null, n = 60): string {
  if (!s) return "—";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function relative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const delta = Math.max(0, now.value - t);
  const s = Math.floor(delta / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function stageClass(video: VideoRow, stage: Stage): string {
  const s = video.status as Status;
  const current = STAGE_OF[s];
  const stages: Stage[] = ["download", "convert", "upload"];
  const curIdx = stages.indexOf(current);
  const thisIdx = stages.indexOf(stage);
  if (s === "UPLOADED") return "done";
  if (FAILED.has(s) && current === stage) return "failed";
  if (thisIdx < curIdx) return "done";
  if (thisIdx === curIdx) return ACTIVE.has(s) ? "active" : "current";
  return "pending";
}

function rowClass(video: VideoRow): string {
  const classes: string[] = [];
  if (FAILED.has(video.status as Status)) classes.push("row-failed");
  if (flashes.value[video.id]) classes.push("row-flash");
  return classes.join(" ");
}

// ── Real-time updates ─────────────────────────────────────────────
const events = useEvents();

function flash(id: number): void {
  const prev = flashes.value[id];
  if (prev) clearTimeout(prev);
  flashes.value = { ...flashes.value, [id]: setTimeout(() => {
    const copy = { ...flashes.value };
    delete copy[id];
    flashes.value = copy;
  }, 900) as unknown as number };
}

function applyVideoUpdate(payload: VideoStatusEvent): void {
  const idx = videos.value.findIndex((v) => v.id === payload.id);
  if (idx < 0) return;
  const next = { ...videos.value[idx], ...payload };
  videos.value = [
    ...videos.value.slice(0, idx),
    next,
    ...videos.value.slice(idx + 1),
  ];
  flash(payload.id);
}

events.onVideoUpdate(applyVideoUpdate);
events.onSyncComplete(() => { void Promise.all([loadChannels(), load()]); });

onMounted(async () => {
  await Promise.all([loadChannels(), load()]);
  clockTimer = setInterval(() => { now.value = Date.now(); }, 15_000);
});
onUnmounted(() => {
  if (clockTimer) clearInterval(clockTimer);
  for (const t of Object.values(flashes.value)) if (t) clearTimeout(t as unknown as number);
});

function toggleStatus(s: Status): void {
  const set = new Set(statusFilter.value);
  if (set.has(s)) set.delete(s); else set.add(s);
  statusFilter.value = Array.from(set) as Status[];
  void load();
}

function clearFilters(): void {
  channelFilter.value = "";
  statusFilter.value = [];
  void load();
}

function onChannelFilterChange(): void {
  void load();
}

function channelDisplayName(c: ChannelSummary): string {
  return c.youtube_channel_name ?? c.youtube_channel_url;
}

const summaryEntryOrder = STATUSES;

// ── Delete flow ───────────────────────────────────────────────────
type DeleteTarget =
  | { kind: "video"; video: VideoRow; channelName: string }
  | { kind: "channel"; channel: ChannelSummary; videoCount: number };

const deleteTarget = ref<DeleteTarget | null>(null);
const deleteFromPeertube = ref(false);
const deleting = ref(false);
const deleteError = ref<string | null>(null);

function askDeleteVideo(v: VideoRow, g: ChannelGroup): void {
  deleteTarget.value = { kind: "video", video: v, channelName: channelDisplayName(g.channel) };
  deleteFromPeertube.value = false;
  deleteError.value = null;
}

function askDeleteChannel(g: ChannelGroup): void {
  deleteTarget.value = { kind: "channel", channel: g.channel, videoCount: g.total };
  deleteFromPeertube.value = false;
  deleteError.value = null;
}

function cancelDelete(): void {
  if (deleting.value) return;
  deleteTarget.value = null;
  deleteError.value = null;
}

async function confirmDelete(): Promise<void> {
  const t = deleteTarget.value;
  if (!t) return;
  deleting.value = true;
  deleteError.value = null;
  try {
    if (t.kind === "video") {
      await endpoints.deleteVideo(t.video.id, deleteFromPeertube.value);
      videos.value = videos.value.filter((x) => x.id !== t.video.id);
    } else {
      await endpoints.deleteChannel(t.channel.id, deleteFromPeertube.value);
      channels.value = channels.value.filter((c) => c.id !== t.channel.id);
      videos.value = videos.value.filter((v) => v.channel_id !== t.channel.id);
      delete expanded[t.channel.id];
      persistExpanded();
    }
    deleteTarget.value = null;
  } catch (e) {
    deleteError.value = (e as Error).message;
  } finally {
    deleting.value = false;
  }
}

// ── Retry flow ────────────────────────────────────────────────────
const retrying = reactive<Record<number, boolean>>({});

async function retryVideo(v: VideoRow): Promise<void> {
  retrying[v.id] = true;
  try {
    const res = await endpoints.retryVideo(v.id);
    // Update local state immediately so the UI reflects the change.
    const idx = videos.value.findIndex((x) => x.id === v.id);
    if (idx >= 0) {
      videos.value = [
        ...videos.value.slice(0, idx),
        { ...videos.value[idx], status: res.new_status, progress_pct: 0, error_message: null },
        ...videos.value.slice(idx + 1),
      ];
    }
  } catch (e) {
    // Surface the error briefly via the video's own error_message so
    // the user sees feedback inline.
    const idx = videos.value.findIndex((x) => x.id === v.id);
    if (idx >= 0) {
      videos.value = [
        ...videos.value.slice(0, idx),
        { ...videos.value[idx], error_message: `Retry failed: ${(e as Error).message}` },
        ...videos.value.slice(idx + 1),
      ];
    }
  } finally {
    delete retrying[v.id];
  }
}
</script>

<template>
  <hgroup>
    <h1>Activities</h1>
    <p>Tracked videos grouped by channel. Most recent uploads first.</p>
  </hgroup>

  <!-- ── Filter bar ─────────────────────────────────────────── -->
  <article>
    <header><strong>Filters</strong></header>
    <div class="grid">
      <label>
        Channel
        <select v-model="channelFilter" @change="onChannelFilterChange">
          <option value="">All channels</option>
          <option v-for="c in channels" :key="c.id" :value="String(c.id)">
            {{ channelDisplayName(c) }}
          </option>
        </select>
      </label>
    </div>
    <fieldset class="status-filter">
      <legend><small>Status</small></legend>
      <label v-for="s in STATUSES" :key="s" class="chip">
        <input type="checkbox" :checked="statusFilter.includes(s)" @change="toggleStatus(s)" />
        <span class="badge" :data-status="s">{{ s }}</span>
      </label>
      <button type="button" class="secondary outline" @click="clearFilters">Clear</button>
    </fieldset>
  </article>

  <p v-if="loading" aria-busy="true">Loading…</p>
  <p v-else-if="err" class="error">{{ err }}</p>
  <p v-else-if="groups.length === 0">No channels to show.</p>

  <!-- ── Channel blocks ─────────────────────────────────────── -->
  <article v-for="g in groups" :key="g.channel.id" class="channel-block">
    <header class="channel-head" @click="toggleExpanded(g.channel.id)">
      <img
        v-if="g.channel.avatar_url"
        :src="g.channel.avatar_url"
        :alt="`${channelDisplayName(g.channel)} avatar`"
        class="avatar"
      />
      <div v-else class="avatar avatar-placeholder" aria-hidden="true">
        {{ channelDisplayName(g.channel).slice(0, 2).toUpperCase() }}
      </div>
      <div class="channel-title">
        <strong>{{ channelDisplayName(g.channel) }}</strong>
        <small class="muted">
          {{ g.total }} video{{ g.total === 1 ? "" : "s" }}
        </small>
      </div>
      <div class="status-counts">
        <span
          v-for="s in summaryEntryOrder"
          v-show="g.statusCounts[s]"
          :key="s"
          class="badge count"
          :data-status="s"
          :title="s"
        >
          {{ s }} {{ g.statusCounts[s] }}
        </span>
      </div>
      <button
        type="button"
        class="secondary outline toggle"
        :aria-expanded="isExpanded(g.channel.id)"
        @click.stop="toggleExpanded(g.channel.id)"
      >
        {{ isExpanded(g.channel.id) ? "Collapse" : "Expand" }}
      </button>
      <button
        type="button"
        class="contrast outline delete"
        title="Remove channel and all its videos"
        @click.stop="askDeleteChannel(g)"
      >
        Remove
      </button>
    </header>

    <div v-if="isExpanded(g.channel.id)" class="channel-body">
      <p v-if="g.videos.length === 0" class="muted">No videos yet.</p>
      <div v-else class="overflow-auto">
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Uploaded</th>
              <th>Status</th>
              <th>Pipeline</th>
              <th>Progress</th>
              <th>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="v in pageVideos(g.videos, g.channel.id)" :key="v.id" :class="rowClass(v)">
              <td :title="v.title ?? ''">
                <a :href="`https://www.youtube.com/watch?v=${v.youtube_video_id}`" target="_blank" rel="noopener">
                  {{ truncate(v.title) }}
                </a>
              </td>
              <td><small>{{ v.upload_date ?? "—" }}</small></td>
              <td>
                <span class="badge" :data-status="v.status" :title="v.error_message ?? ''">
                  {{ v.status }}
                </span>
              </td>
              <td>
                <span class="pipeline" :aria-label="`Pipeline ${v.status}`">
                  <span class="pip" :class="stageClass(v, 'download')" title="Download">DL</span>
                  <span class="arrow">→</span>
                  <span class="pip" :class="stageClass(v, 'convert')" title="Convert">CV</span>
                  <span class="arrow">→</span>
                  <span class="pip" :class="stageClass(v, 'upload')" title="Upload">UP</span>
                </span>
              </td>
              <td>
                <template v-if="ACTIVE.has(v.status as Status)">
                  <progress :value="v.progress_pct" max="100" />
                  <small class="muted">&nbsp;{{ v.progress_pct }}%</small>
                </template>
                <small v-else-if="v.status === 'UPLOADED'" class="muted">100%</small>
                <small v-else class="muted">—</small>
              </td>
              <td><small :title="v.updated_at">{{ relative(v.updated_at) }}</small></td>
              <td>
                <button
                  v-if="FAILED.has(v.status as Status)"
                  type="button"
                  class="outline row-retry"
                  title="Retry this video"
                  :disabled="retrying[v.id]"
                  :aria-busy="retrying[v.id]"
                  @click="retryVideo(v)"
                >
                  Retry
                </button>
                <button
                  type="button"
                  class="contrast outline row-delete"
                  title="Delete this video"
                  @click="askDeleteVideo(v, g)"
                >
                  Delete
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <nav v-if="channelPageCount(g.videos.length) > 1" class="channel-pager">
        <button
          v-for="p in channelPageCount(g.videos.length)"
          :key="p"
          type="button"
          :class="['outline', p === currentChannelPage(g.channel.id) ? 'primary' : 'secondary']"
          @click="setChannelPage(g.channel.id, p)"
        >
          {{ p }}
        </button>
      </nav>
    </div>
  </article>

  <!-- ── Delete confirm dialog ──────────────────────────────── -->
  <dialog :open="deleteTarget !== null">
    <article v-if="deleteTarget">
      <header>
        <strong v-if="deleteTarget.kind === 'video'">Delete video?</strong>
        <strong v-else>Remove channel?</strong>
      </header>
      <p v-if="deleteTarget.kind === 'video'">
        <code>{{ truncate(deleteTarget.video.title, 80) }}</code>
        <br />
        <small class="muted">Channel: {{ deleteTarget.channelName }}</small>
      </p>
      <p v-else>
        <strong>{{ channelDisplayName(deleteTarget.channel) }}</strong>
        <br />
        <small class="muted">
          This will delete the channel mapping and
          <strong>{{ deleteTarget.videoCount }}</strong>
          tracked video{{ deleteTarget.videoCount === 1 ? "" : "s" }}
          (local files and database rows).
        </small>
      </p>
      <label>
        <input type="checkbox" v-model="deleteFromPeertube" />
        Also delete
        <template v-if="deleteTarget.kind === 'channel'">each video</template>
        <template v-else>the video</template>
        from PeerTube
      </label>
      <p v-if="deleteError" class="error">{{ deleteError }}</p>
      <footer>
        <button type="button" class="secondary" :disabled="deleting" @click="cancelDelete">
          Cancel
        </button>
        <button type="button" class="contrast" :disabled="deleting" @click="confirmDelete">
          {{ deleting ? "Deleting…" : "Delete" }}
        </button>
      </footer>
    </article>
  </dialog>
</template>

<style scoped>
.status-filter {
  margin-top: 0.75rem;
  display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center;
}
.status-filter button { margin: 0 0 0 auto; width: auto; }
.chip {
  display: inline-flex; align-items: center; gap: 0.3rem;
  cursor: pointer; margin: 0;
}
.chip input { margin: 0; }

.channel-block { padding: 0; }
.channel-head {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  cursor: pointer;
  user-select: none;
  margin: 0;
}
.channel-head:hover { background: var(--pico-muted-border-color); }
.avatar {
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 50%;
  object-fit: cover;
  background: var(--pico-muted-border-color);
  flex-shrink: 0;
}
.avatar-placeholder {
  display: flex; align-items: center; justify-content: center;
  font-size: 0.85rem; font-weight: 600; opacity: 0.7;
}
.channel-title {
  display: flex; flex-direction: column;
  min-width: 8rem;
}
.channel-title small { opacity: 0.7; }
.status-counts {
  display: flex; flex-wrap: wrap; gap: 0.3rem;
  flex: 1; justify-content: flex-end;
}
.toggle { margin: 0; width: auto; flex-shrink: 0; }
.delete, .row-delete, .row-retry {
  margin: 0;
  width: auto;
  flex-shrink: 0;
  padding: 0.3rem 0.6rem;
  font-size: 0.8rem;
}
.channel-body { padding: 0.5rem 1rem 1rem; }

.badge {
  display: inline-block;
  font-size: 0.72rem;
  font-weight: 600;
  padding: 0.12rem 0.5rem;
  border-radius: 999px;
  background: var(--pico-muted-border-color);
  white-space: nowrap;
}
.badge.count { font-size: 0.68rem; padding: 0.1rem 0.45rem; }
.badge[data-status="DOWNLOAD_QUEUED"],
.badge[data-status="CONVERT_QUEUED"],
.badge[data-status="UPLOAD_QUEUED"]      { background: #ececec; color: #444; }
.badge[data-status="DOWNLOADING"],
.badge[data-status="CONVERTING"],
.badge[data-status="UPLOADING"]          { background: #cfe0ff; color: #143a85; animation: pulse 1.6s ease-in-out infinite; }
.badge[data-status="DOWNLOAD_FAILED"],
.badge[data-status="CONVERT_FAILED"],
.badge[data-status="UPLOAD_FAILED"]      { background: #fcd6d6; color: #7a1313; }
.badge[data-status="UPLOADED"]           { background: #d1f2e1; color: #0e5a3a; }

@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }

.pipeline {
  display: inline-flex; align-items: center; gap: 0.25rem;
  font-size: 0.72rem; font-weight: 600;
}
.pip {
  display: inline-block;
  min-width: 1.6rem;
  padding: 0.12rem 0.35rem;
  text-align: center;
  border-radius: 4px;
  background: #ececec; color: #999;
}
.pip.done     { background: #3ad29f; color: #fff; }
.pip.active   { background: #5a8dee; color: #fff; animation: pulse 1.4s ease-in-out infinite; }
.pip.current  { background: #c7d4f7; color: #143a85; }
.pip.failed   { background: #d04a4a; color: #fff; }
.arrow { opacity: 0.4; }

progress { width: 8rem; height: 0.6rem; margin: 0; }

.row-failed td { background: rgba(208, 74, 74, 0.06); }
.row-flash td  { animation: flash 0.9s ease-out; }
@keyframes flash {
  0%   { background: rgba(90, 141, 238, 0.25); }
  100% { background: transparent; }
}

.muted { opacity: 0.75; }
.error { color: var(--pico-del-color, crimson); }
.overflow-auto { overflow-x: auto; }
.channel-pager {
  display: flex; flex-wrap: wrap; gap: 0.25rem;
  justify-content: center;
  padding: 0.5rem 1rem;
}
.channel-pager button {
  width: auto; min-width: 2.5rem;
  margin: 0; padding: 0.25rem 0.6rem;
  font-size: 0.85rem;
}
</style>
