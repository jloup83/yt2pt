<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import {
  endpoints,
  type ApiError,
  type Settings,
  type SettingsPatch,
} from "../api";

// ── Default placeholders (shown in empty text inputs) ─────────────
const DEFAULTS = {
  yt2pt: {
    data_dir: "~/yt2pt/data",
    log_dir: "~/yt2pt/logs",
  },
  http: { port: 8090, bind: "0.0.0.0" },
  workers: { download_concurrency: 1, convert_concurrency: 1, upload_concurrency: 1 },
  ytdlp: { format: "bv*+ba/b", merge_output_format: "mkv", thumbnail_format: "jpg" },
  peertube: { instance_url: "https://peertube.example.com", channel_id: "", language: "en", licence: "" },
} as const;

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
const MERGE_FORMATS = ["mkv", "mp4", "webm"] as const;
const THUMB_FORMATS = ["jpg", "png", "webp"] as const;
const PRIVACIES = ["public", "unlisted", "private", "internal", "password_protected"] as const;
const COMMENTS_POLICIES = ["enabled", "disabled", "requires_approval"] as const;
// Well-known Creative Commons identifiers used by PeerTube (value: label).
const LICENCES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "(none)" },
  { value: "1", label: "Attribution" },
  { value: "2", label: "Attribution - Share Alike" },
  { value: "3", label: "Attribution - No Derivatives" },
  { value: "4", label: "Attribution - Non Commercial" },
  { value: "5", label: "Attribution - Non Commercial - Share Alike" },
  { value: "6", label: "Attribution - Non Commercial - No Derivatives" },
  { value: "7", label: "Public Domain Dedication" },
];

// ── State ─────────────────────────────────────────────────────────
const loading = ref(true);
const saving = ref(false);
const loadError = ref<string | null>(null);
const saveStatus = ref<{ kind: "ok" | "err"; msg: string } | null>(null);

const original = ref<Settings | null>(null);
const form = reactive<Settings>({
  yt2pt: {
    data_dir: "", log_dir: "", log_level: "info",
    overwrite_existing: false, skip_downloaded: true,
    remove_video_after_upload: false, remove_video_after_metadata_conversion: false,
  },
  http: { port: 8090, bind: "" },
  workers: { download_concurrency: 1, convert_concurrency: 1, upload_concurrency: 1 },
  ytdlp: { format: "", merge_output_format: "mkv", thumbnail_format: "jpg" },
  peertube: {
    instance_url: "", api_token: "", channel_id: "",
    privacy: "public", language: "", licence: "",
    comments_policy: "enabled", wait_transcoding: true, generate_transcription: true,
  },
});

// Token acquisition (transient — never sent in PUT /settings)
const ptUsername = ref("");
const ptPassword = ref("");
const tokenBusy = ref(false);
const tokenStatus = ref<{ kind: "ok" | "err"; msg: string } | null>(null);
const tokenIsSet = computed(() => (form.peertube.api_token ?? "").length > 0);

// ── Load ──────────────────────────────────────────────────────────
onMounted(async () => {
  try {
    const s = await endpoints.getSettings();
    original.value = structuredClone(s);
    applySettings(s);
  } catch (err) {
    loadError.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
});

function applySettings(s: Settings): void {
  Object.assign(form.yt2pt, s.yt2pt);
  Object.assign(form.http, s.http);
  Object.assign(form.workers, s.workers);
  Object.assign(form.ytdlp, s.ytdlp);
  Object.assign(form.peertube, s.peertube);
}

// ── Diff (only send changed keys, never the masked api_token) ─────
function computePatch(): SettingsPatch {
  if (!original.value) return {};
  const patch: SettingsPatch = {};
  const orig = original.value;
  (Object.keys(form) as (keyof Settings)[]).forEach((section) => {
    const before = orig[section] as Record<string, unknown>;
    const after = form[section] as Record<string, unknown>;
    const sectionPatch: Record<string, unknown> = {};
    for (const key of Object.keys(after)) {
      // api_token: read-only in this form (displayed masked, rotated via /token)
      if (section === "peertube" && key === "api_token") continue;
      if (after[key] !== before[key]) sectionPatch[key] = after[key];
    }
    if (Object.keys(sectionPatch).length > 0) {
      (patch as Record<string, unknown>)[section] = sectionPatch;
    }
  });
  return patch;
}

const hasChanges = computed(() => Object.keys(computePatch()).length > 0);

// ── Save ──────────────────────────────────────────────────────────
async function onSave(): Promise<void> {
  saveStatus.value = null;
  const patch = computePatch();
  if (Object.keys(patch).length === 0) {
    saveStatus.value = { kind: "ok", msg: "No changes." };
    return;
  }

  // Lightweight client-side validation (server validates too)
  if (patch.http?.port !== undefined) {
    const p = patch.http.port;
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      saveStatus.value = { kind: "err", msg: "http.port must be 1..65535" };
      return;
    }
  }
  for (const k of ["download_concurrency", "convert_concurrency", "upload_concurrency"] as const) {
    const v = patch.workers?.[k];
    if (v !== undefined && (!Number.isInteger(v) || v < 1 || v > 32)) {
      saveStatus.value = { kind: "err", msg: `workers.${k} must be 1..32` };
      return;
    }
  }

  saving.value = true;
  try {
    const updated = await endpoints.updateSettings(patch);
    original.value = structuredClone(updated);
    applySettings(updated);
    saveStatus.value = { kind: "ok", msg: "Settings saved." };
  } catch (err) {
    const e = err as ApiError;
    const details = Array.isArray((e.body as { details?: unknown })?.details)
      ? ((e.body as { details: Array<{ path: string; message: string }> }).details)
          .map((d) => `${d.path}: ${d.message}`).join("; ")
      : "";
    saveStatus.value = {
      kind: "err",
      msg: details ? `${e.message} — ${details}` : e.message,
    };
  } finally {
    saving.value = false;
  }
}

function onReset(): void {
  if (original.value) {
    applySettings(original.value);
    saveStatus.value = null;
  }
}

// ── PeerTube token acquisition ────────────────────────────────────
async function onAcquireToken(): Promise<void> {
  tokenStatus.value = null;
  if (!ptUsername.value || !ptPassword.value) {
    tokenStatus.value = { kind: "err", msg: "username and password are required" };
    return;
  }
  tokenBusy.value = true;
  try {
    const res = await endpoints.acquireToken(ptUsername.value, ptPassword.value);
    if (!res.success) {
      tokenStatus.value = { kind: "err", msg: res.error ?? "authentication failed" };
      return;
    }
    // Server stored the new token; refresh the form to show masked value.
    const s = await endpoints.getSettings();
    original.value = structuredClone(s);
    applySettings(s);
    ptPassword.value = "";
    tokenStatus.value = { kind: "ok", msg: "Token acquired and saved." };
  } catch (err) {
    tokenStatus.value = { kind: "err", msg: (err as Error).message };
  } finally {
    tokenBusy.value = false;
  }
}
</script>

<template>
  <hgroup>
    <h1>Settings</h1>
    <p>Daemon configuration. Placeholders show defaults; leave blank to use them.</p>
  </hgroup>

  <p v-if="loading" aria-busy="true">Loading settings…</p>
  <article v-else-if="loadError" class="error">
    <strong>Failed to load settings:</strong> {{ loadError }}
  </article>

  <form v-else @submit.prevent="onSave">
    <!-- [yt2pt] -->
    <article>
      <header><strong>General ([yt2pt])</strong></header>
      <label>
        data_dir
        <input type="text" v-model="form.yt2pt.data_dir" :placeholder="DEFAULTS.yt2pt.data_dir" />
      </label>
      <label>
        log_dir
        <input type="text" v-model="form.yt2pt.log_dir" :placeholder="DEFAULTS.yt2pt.log_dir" />
      </label>
      <label>
        log_level
        <select v-model="form.yt2pt.log_level">
          <option v-for="lvl in LOG_LEVELS" :key="lvl" :value="lvl">{{ lvl }}</option>
        </select>
      </label>
      <label><input type="checkbox" v-model="form.yt2pt.overwrite_existing" /> overwrite_existing</label>
      <label><input type="checkbox" v-model="form.yt2pt.skip_downloaded" /> skip_downloaded</label>
      <label><input type="checkbox" v-model="form.yt2pt.remove_video_after_upload" /> remove_video_after_upload</label>
      <label><input type="checkbox" v-model="form.yt2pt.remove_video_after_metadata_conversion" /> remove_video_after_metadata_conversion</label>
    </article>

    <!-- [http] -->
    <article>
      <header><strong>HTTP</strong></header>
      <div class="grid">
        <label>
          port
          <input type="number" min="1" max="65535"
                 v-model.number="form.http.port" :placeholder="String(DEFAULTS.http.port)" />
        </label>
        <label>
          bind
          <input type="text" v-model="form.http.bind" :placeholder="DEFAULTS.http.bind" />
        </label>
      </div>
    </article>

    <!-- [workers] -->
    <article>
      <header><strong>Workers</strong></header>
      <div class="grid">
        <label>
          download_concurrency
          <input type="number" min="1" max="32"
                 v-model.number="form.workers.download_concurrency"
                 :placeholder="String(DEFAULTS.workers.download_concurrency)" />
        </label>
        <label>
          convert_concurrency
          <input type="number" min="1" max="32"
                 v-model.number="form.workers.convert_concurrency"
                 :placeholder="String(DEFAULTS.workers.convert_concurrency)" />
        </label>
        <label>
          upload_concurrency
          <input type="number" min="1" max="32"
                 v-model.number="form.workers.upload_concurrency"
                 :placeholder="String(DEFAULTS.workers.upload_concurrency)" />
        </label>
      </div>
    </article>

    <!-- [ytdlp] -->
    <article>
      <header><strong>yt-dlp</strong></header>
      <label>
        format
        <input type="text" v-model="form.ytdlp.format" :placeholder="DEFAULTS.ytdlp.format" />
      </label>
      <div class="grid">
        <label>
          merge_output_format
          <select v-model="form.ytdlp.merge_output_format">
            <option v-for="f in MERGE_FORMATS" :key="f" :value="f">{{ f }}</option>
          </select>
        </label>
        <label>
          thumbnail_format
          <select v-model="form.ytdlp.thumbnail_format">
            <option v-for="f in THUMB_FORMATS" :key="f" :value="f">{{ f }}</option>
          </select>
        </label>
      </div>
    </article>

    <!-- [peertube] -->
    <article>
      <header><strong>PeerTube</strong></header>
      <label>
        instance_url
        <input type="url" v-model="form.peertube.instance_url" :placeholder="DEFAULTS.peertube.instance_url" />
      </label>

      <label>
        api_token
        <input type="text"
               :value="tokenIsSet ? '•••••• (set)' : '(not set)'"
               readonly />
        <small>Use <em>Get Token</em> below to rotate. The raw token is never exposed over the API.</small>
      </label>

      <fieldset>
        <legend>Acquire token</legend>
        <div class="grid">
          <label>
            Username
            <input type="text" autocomplete="username" v-model="ptUsername" :disabled="tokenBusy" />
          </label>
          <label>
            Password
            <input type="password" autocomplete="current-password"
                   v-model="ptPassword" :disabled="tokenBusy" />
          </label>
        </div>
        <button type="button" class="secondary" :aria-busy="tokenBusy"
                :disabled="tokenBusy || !ptUsername || !ptPassword"
                @click="onAcquireToken">
          Get Token
        </button>
        <p v-if="tokenStatus" :class="tokenStatus.kind === 'ok' ? 'ok' : 'error'">
          {{ tokenStatus.msg }}
        </p>
        <small>Credentials are sent once to the daemon, exchanged for an API token, then discarded.</small>
      </fieldset>

      <label>
        channel_id
        <input type="text" v-model="form.peertube.channel_id" />
        <small>Default PeerTube channel for new uploads. May be overridden per channel.</small>
      </label>

      <div class="grid">
        <label>
          privacy
          <select v-model="form.peertube.privacy">
            <option v-for="p in PRIVACIES" :key="p" :value="p">{{ p }}</option>
          </select>
        </label>
        <label>
          comments_policy
          <select v-model="form.peertube.comments_policy">
            <option v-for="c in COMMENTS_POLICIES" :key="c" :value="c">{{ c }}</option>
          </select>
        </label>
      </div>
      <div class="grid">
        <label>
          language
          <input type="text" v-model="form.peertube.language" :placeholder="DEFAULTS.peertube.language" />
        </label>
        <label>
          licence
          <select v-model="form.peertube.licence">
            <option v-for="l in LICENCES" :key="l.value" :value="l.value">{{ l.label }}</option>
          </select>
        </label>
      </div>
      <label><input type="checkbox" v-model="form.peertube.wait_transcoding" /> wait_transcoding</label>
      <label><input type="checkbox" v-model="form.peertube.generate_transcription" /> generate_transcription</label>
    </article>

    <!-- Save bar -->
    <footer class="save-bar">
      <button type="submit" :aria-busy="saving" :disabled="saving || !hasChanges">Save changes</button>
      <button type="button" class="secondary outline" :disabled="saving || !hasChanges" @click="onReset">
        Reset
      </button>
      <span v-if="saveStatus" :class="saveStatus.kind === 'ok' ? 'ok' : 'error'">{{ saveStatus.msg }}</span>
    </footer>
  </form>
</template>

<style scoped>
article { margin-bottom: 1.25rem; }
fieldset { margin-top: 0.5rem; }
.save-bar {
  position: sticky; bottom: 0;
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.75rem 0;
  background: var(--pico-background-color);
  border-top: 1px solid var(--pico-muted-border-color);
}
.save-bar button { margin: 0; width: auto; }
.ok { color: var(--pico-ins-color, green); }
.error { color: var(--pico-del-color, crimson); }
</style>
