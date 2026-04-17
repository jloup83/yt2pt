<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { endpoints, type PeertubeStatus } from "../api";

const status = ref<PeertubeStatus | null>(null);
const error = ref<string | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;

async function poll(): Promise<void> {
  try {
    status.value = await endpoints.peertubeStatus();
    error.value = null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    status.value = null;
  }
}

onMounted(() => {
  void poll();
  timer = setInterval(() => void poll(), 5000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <span
    class="status"
    :class="status?.online && status?.authenticated ? 'ok' : status?.online ? 'warn' : 'down'"
    :title="
      error
        ? `API unreachable: ${error}`
        : status
          ? `PeerTube ${status.online ? 'online' : 'offline'}${status.authenticated ? ', authenticated' : ''}${status.instance_url ? ' — ' + status.instance_url : ''}`
          : 'checking…'
    "
  >
    ●
    <span class="label">
      {{
        error
          ? "api down"
          : status?.authenticated
            ? "online"
            : status?.online
              ? "unauthenticated"
              : "offline"
      }}
    </span>
  </span>
</template>

<style scoped>
.status {
  font-size: 0.8rem;
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  color: currentColor;
}
.status.ok    { color: #3ad29f; }
.status.warn  { color: #e7a33c; }
.status.down  { color: #d04a4a; }
.label {
  font-weight: 500;
  text-transform: lowercase;
}
</style>
