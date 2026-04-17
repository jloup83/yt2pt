<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
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
const total = ref(0);
const page = ref(1);
const perPage = ref(50);
const sort = ref<"updated_at" | "created_at" | "title">("updated_at");
const order = ref<"asc" | "desc">("desc");

const loading = ref(true);
const err = ref<string | null>(null);

const channels = ref<ChannelSummary[]>([]);
const channelFilter = ref<string>("");
const statusFilter = ref<Status[]>([]);
const flashes = ref<Record<number, number>>({}); // video id -> timeout id

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
    params.set("page", String(page.value));
    params.set("per_page", String(perPage.value));
    params.set("sort", sort.value);
    params.set("order", order.value);
    const res = await endpoints.listVideos(params);
    videos.value = res.videos;
    total.value = res.total;
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

async function loadChannels(): Promise<void> {
  try {
    const res = await endpoints.listChannels();
    channels.value = res.channels;
  } catch {
    // Filter dropdown is optional — silent fail is fine.
  }
}

// Re-query when filters / paging change
watch([channelFilter, statusFilter, perPage, sort, order], () => {
  page.value = 1;
  void load();
});
watch(page, () => { void load(); });

// ── Pagination helpers ────────────────────────────────────────────
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / perPage.value)));
const rangeFrom = computed(() => (total.value === 0 ? 0 : (page.value - 1) * perPage.value + 1));
const rangeTo = computed(() => Math.min(total.value, page.value * perPage.value));

function prev(): void { if (page.value > 1) page.value -= 1; }
function next(): void { if (page.value < totalPages.value) page.value += 1; }

// ── Formatting ────────────────────────────────────────────────────
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
  const order: Stage[] = ["download", "convert", "upload"];
  const curIdx = order.indexOf(current);
  const thisIdx = order.indexOf(stage);
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

// ── Real-time row updates via the shared SSE composable ──────────
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
events.onSyncComplete(() => { void load(); });

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
}

function clearFilters(): void {
  channelFilter.value = "";
  statusFilter.value = [];
}
</script>

<template>
  <hgroup>
    <h1>Activities</h1>
    <p>All tracked videos across every mapped channel.</p>
  </hgroup>

  <!-- ── Filter bar ─────────────────────────────────────────── -->
  <article>
    <header><strong>Filters</strong></header>
    <div class="grid">
      <label>
        Channel
        <select v-model="channelFilter">
          <option value="">All channels</option>
          <option v-for="c in channels" :key="c.id" :value="String(c.id)">
            {{ c.youtube_channel_name ?? c.youtube_channel_url }}
          </option>
        </select>
      </label>
      <label>
        Per page
        <select v-model.number="perPage">
          <option :value="25">25</option>
          <option :value="50">50</option>
          <option :value="100">100</option>
          <option :value="200">200</option>
        </select>
      </label>
      <label>
        Sort
        <select v-model="sort">
          <option value="updated_at">Updated</option>
          <option value="created_at">Created</option>
          <option value="title">Title</option>
        </select>
      </label>
      <label>
        Order
        <select v-model="order">
          <option value="desc">Newest first</option>
          <option value="asc">Oldest first</option>
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

  <!-- ── Table ──────────────────────────────────────────────── -->
  <article>
    <header>
      <strong>Videos</strong>
      <small class="muted">
        &nbsp; {{ rangeFrom }}–{{ rangeTo }} of {{ total }}
      </small>
    </header>

    <p v-if="loading" aria-busy="true">Loading…</p>
    <p v-else-if="err" class="error">{{ err }}</p>
    <p v-else-if="videos.length === 0">No videos tracked yet.</p>

    <div v-else class="overflow-auto">
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Channel</th>
            <th>Status</th>
            <th>Pipeline</th>
            <th>Progress</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="v in videos" :key="v.id" :class="rowClass(v)">
            <td :title="v.title ?? ''">
              <a :href="`https://www.youtube.com/watch?v=${v.youtube_video_id}`" target="_blank" rel="noopener">
                {{ truncate(v.title) }}
              </a>
            </td>
            <td><small>{{ v.channel_name ?? "—" }}</small></td>
            <td>
              <span
                class="badge"
                :data-status="v.status"
                :title="v.error_message ?? ''"
              >
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
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Pagination -->
    <footer v-if="total > perPage" class="pager">
      <button type="button" class="secondary outline" :disabled="page <= 1" @click="prev">« Prev</button>
      <span>Page {{ page }} / {{ totalPages }}</span>
      <button type="button" class="secondary outline" :disabled="page >= totalPages" @click="next">Next »</button>
    </footer>
  </article>
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

.badge {
  display: inline-block;
  font-size: 0.72rem;
  font-weight: 600;
  padding: 0.12rem 0.5rem;
  border-radius: 999px;
  background: var(--pico-muted-border-color);
  white-space: nowrap;
}
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
.pager {
  display: flex; align-items: center; gap: 0.75rem;
  margin-top: 0.5rem;
}
.pager button { margin: 0; width: auto; }
</style>
