<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  endpoints,
  type ApiError,
  type ChannelSummary,
  type PeertubeChannel,
  type PeertubeStatus,
} from "../api";

// ── PeerTube status polling (every 5 s) ───────────────────────────
const ptStatus = ref<PeertubeStatus | null>(null);
const ptStatusError = ref<string | null>(null);
let statusTimer: ReturnType<typeof setInterval> | null = null;

async function pollStatus(): Promise<void> {
  try {
    ptStatus.value = await endpoints.peertubeStatus();
    ptStatusError.value = null;
  } catch (err) {
    ptStatusError.value = (err as Error).message;
  }
}

// ── Channel list ──────────────────────────────────────────────────
const channels = ref<ChannelSummary[]>([]);
const channelsLoading = ref(true);
const channelsError = ref<string | null>(null);

async function loadChannels(): Promise<void> {
  try {
    const res = await endpoints.listChannels();
    channels.value = res.channels;
    channelsError.value = null;
  } catch (err) {
    channelsError.value = (err as Error).message;
  } finally {
    channelsLoading.value = false;
  }
}

// ── Add Channel form ──────────────────────────────────────────────
const ytUrl = ref("");
const selectedPtChannel = ref<string>("");
const ptChannels = ref<PeertubeChannel[]>([]);
const ptChannelsLoading = ref(false);
const ptChannelsError = ref<string | null>(null);
const addBusy = ref(false);
const addStatus = ref<{ kind: "ok" | "err"; msg: string } | null>(null);

async function loadPtChannels(): Promise<void> {
  ptChannelsLoading.value = true;
  ptChannelsError.value = null;
  try {
    const res = await endpoints.peertubeChannels();
    ptChannels.value = res.channels;
    if (res.channels.length > 0 && !selectedPtChannel.value) {
      selectedPtChannel.value = String(res.channels[0].id);
    }
  } catch (err) {
    const e = err as ApiError;
    ptChannelsError.value =
      e.status === 401
        ? "Not authenticated with PeerTube — set a token on the Settings page."
        : e.message;
  } finally {
    ptChannelsLoading.value = false;
  }
}

async function onAddChannel(): Promise<void> {
  addStatus.value = null;
  if (!ytUrl.value.trim() || !selectedPtChannel.value) {
    addStatus.value = { kind: "err", msg: "YouTube URL and PeerTube channel are required." };
    return;
  }
  addBusy.value = true;
  try {
    const created = await endpoints.addChannel(ytUrl.value.trim(), selectedPtChannel.value);
    // Immediately trigger a sync per spec; swallow non-fatal failures
    // (e.g. 429 rate limited) so the channel still appears in the list.
    try {
      await endpoints.syncChannel(created.id);
    } catch (err) {
      const e = err as ApiError;
      addStatus.value = {
        kind: "ok",
        msg: `Channel added. Sync could not start: ${e.message}`,
      };
    }
    addStatus.value = addStatus.value ?? { kind: "ok", msg: "Channel added and sync started." };
    ytUrl.value = "";
    await loadChannels();
  } catch (err) {
    addStatus.value = { kind: "err", msg: (err as Error).message };
  } finally {
    addBusy.value = false;
  }
}

// ── Per-row actions ───────────────────────────────────────────────
const rowBusy = ref<Record<number, "sync" | "delete" | undefined>>({});
const rowStatus = ref<Record<number, string | undefined>>({});

async function onResync(c: ChannelSummary): Promise<void> {
  rowBusy.value = { ...rowBusy.value, [c.id]: "sync" };
  rowStatus.value = { ...rowStatus.value, [c.id]: undefined };
  try {
    await endpoints.syncChannel(c.id);
    rowStatus.value = { ...rowStatus.value, [c.id]: "sync started" };
    // Refresh list shortly after so last_synced_at / counts update.
    setTimeout(() => { void loadChannels(); }, 1500);
  } catch (err) {
    rowStatus.value = { ...rowStatus.value, [c.id]: (err as Error).message };
  } finally {
    rowBusy.value = { ...rowBusy.value, [c.id]: undefined };
  }
}

async function onDelete(c: ChannelSummary): Promise<void> {
  const label = c.youtube_channel_name ?? c.youtube_channel_url;
  if (!window.confirm(`Remove channel "${label}"? Tracked videos stay in the database.`)) return;
  rowBusy.value = { ...rowBusy.value, [c.id]: "delete" };
  try {
    await endpoints.deleteChannel(c.id);
    await loadChannels();
  } catch (err) {
    rowStatus.value = { ...rowStatus.value, [c.id]: (err as Error).message };
  } finally {
    rowBusy.value = { ...rowBusy.value, [c.id]: undefined };
  }
}

function summaryEntries(s: Record<string, number>): Array<[string, number]> {
  return Object.entries(s).sort(([a], [b]) => a.localeCompare(b));
}
function fmtTs(ts: string | null): string {
  if (!ts) return "never";
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

const canAdd = computed(
  () => !addBusy.value && ytUrl.value.trim().length > 0 && selectedPtChannel.value.length > 0,
);

onMounted(async () => {
  await Promise.all([pollStatus(), loadChannels(), loadPtChannels()]);
  statusTimer = setInterval(() => void pollStatus(), 5000);
});
onUnmounted(() => { if (statusTimer) clearInterval(statusTimer); });
</script>

<template>
  <hgroup>
    <h1>Home</h1>
    <p>PeerTube connection + mapped YouTube channels.</p>
  </hgroup>

  <!-- ── PeerTube status bar ──────────────────────────────────── -->
  <article>
    <header><strong>PeerTube</strong></header>
    <div class="status-bar">
      <span class="dot" :class="ptStatus?.online ? 'ok' : 'down'" />
      <span>Online: <strong>{{ ptStatus?.online ? "yes" : "no" }}</strong></span>
      <span class="sep">·</span>
      <span class="dot" :class="ptStatus?.authenticated ? 'ok' : 'down'" />
      <span>Connected: <strong>{{ ptStatus?.authenticated ? "yes" : "no" }}</strong></span>
      <span class="sep">·</span>
      <small>
        <span v-if="ptStatus?.instance_url">{{ ptStatus.instance_url }}</span>
        <span v-if="ptStatus?.username"> — {{ ptStatus.username }}</span>
        <span v-if="ptStatusError" class="error"> ({{ ptStatusError }})</span>
      </small>
    </div>
  </article>

  <!-- ── Channel list ─────────────────────────────────────────── -->
  <article>
    <header><strong>Channels</strong></header>

    <p v-if="channelsLoading" aria-busy="true">Loading channels…</p>
    <p v-else-if="channelsError" class="error">{{ channelsError }}</p>
    <p v-else-if="channels.length === 0">No channels mapped yet. Add one below.</p>

    <div v-else class="overflow-auto">
      <table>
        <thead>
          <tr>
            <th>YouTube channel</th>
            <th>PeerTube channel</th>
            <th>Videos</th>
            <th>Status</th>
            <th>Last synced</th>
            <th class="actions">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in channels" :key="c.id">
            <td>
              <a :href="c.youtube_channel_url" target="_blank" rel="noopener">
                {{ c.youtube_channel_name ?? c.youtube_channel_url }}
              </a>
            </td>
            <td><code>{{ c.peertube_channel_id }}</code></td>
            <td>{{ c.video_count }}</td>
            <td>
              <span v-if="summaryEntries(c.status_summary).length === 0">—</span>
              <span
                v-for="[status, n] in summaryEntries(c.status_summary)"
                :key="status"
                class="badge"
                :data-status="status"
                :title="`${n} ${status}`"
              >{{ n }} {{ status }}</span>
            </td>
            <td><small>{{ fmtTs(c.last_synced_at) }}</small></td>
            <td class="actions">
              <button
                type="button"
                class="secondary"
                :aria-busy="rowBusy[c.id] === 'sync'"
                :disabled="!!rowBusy[c.id]"
                @click="onResync(c)"
              >Re-sync</button>
              <button
                type="button"
                class="secondary outline"
                :aria-busy="rowBusy[c.id] === 'delete'"
                :disabled="!!rowBusy[c.id]"
                @click="onDelete(c)"
              >Delete</button>
              <small v-if="rowStatus[c.id]" class="muted"> {{ rowStatus[c.id] }}</small>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </article>

  <!-- ── Add channel ──────────────────────────────────────────── -->
  <article>
    <header><strong>Add channel</strong></header>
    <form @submit.prevent="onAddChannel">
      <label>
        YouTube channel URL
        <input
          type="url"
          v-model="ytUrl"
          placeholder="https://www.youtube.com/@SomeChannel"
          :disabled="addBusy"
        />
      </label>
      <label>
        PeerTube channel
        <select v-model="selectedPtChannel" :disabled="addBusy || ptChannelsLoading || ptChannels.length === 0">
          <option value="" disabled>
            {{ ptChannelsLoading ? "Loading…" : ptChannels.length === 0 ? "(none available)" : "Select a channel" }}
          </option>
          <option v-for="ch in ptChannels" :key="ch.id" :value="String(ch.id)">
            {{ ch.displayName }} ({{ ch.name }})
          </option>
        </select>
        <small v-if="ptChannelsError" class="error">{{ ptChannelsError }}</small>
      </label>
      <div class="row">
        <button type="submit" :aria-busy="addBusy" :disabled="!canAdd">Sync channel</button>
        <button type="button" class="secondary outline" :disabled="ptChannelsLoading" @click="loadPtChannels">
          Refresh PeerTube channels
        </button>
        <span v-if="addStatus" :class="addStatus.kind === 'ok' ? 'ok' : 'error'">{{ addStatus.msg }}</span>
      </div>
    </form>
  </article>
</template>

<style scoped>
.status-bar {
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem;
}
.sep { opacity: 0.4; }
.dot {
  display: inline-block; width: 0.7rem; height: 0.7rem; border-radius: 50%;
  background: var(--pico-muted-color);
}
.dot.ok   { background: #3ad29f; }
.dot.down { background: #d04a4a; }
.badge {
  display: inline-block;
  font-size: 0.75rem;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  background: var(--pico-muted-border-color);
  margin-right: 0.25rem;
  white-space: nowrap;
}
.badge[data-status="uploaded"]  { background: #d1f2e1; color: #0e5a3a; }
.badge[data-status="uploading"] { background: #fff4d1; color: #6b4a00; }
.badge[data-status="queued"]    { background: #e1ecff; color: #143a85; }
.badge[data-status="failed"]    { background: #fcd6d6; color: #7a1313; }
.badge[data-status="tracked"]   { background: #ececec; color: #333; }
th.actions, td.actions {
  white-space: nowrap;
  text-align: right;
}
td.actions button { margin: 0 0 0 0.25rem; width: auto; }
.row { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
.row button { margin: 0; width: auto; }
.muted { opacity: 0.75; }
.ok    { color: var(--pico-ins-color, green); }
.error { color: var(--pico-del-color, crimson); }
.overflow-auto { overflow-x: auto; }
</style>
