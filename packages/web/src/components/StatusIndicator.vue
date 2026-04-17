<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { endpoints, type PeertubeStatus } from "../api";
import { useEvents } from "../composables/useEvents";

const status = ref<PeertubeStatus | null>(null);
const error = ref<string | null>(null);

const events = useEvents();
watch(
  events.peertubeStatus,
  (next) => {
    if (next) {
      status.value = next;
      error.value = null;
    }
  },
  { immediate: true },
);

onMounted(async () => {
  // One-shot HTTP fetch to populate the dot before the first SSE frame
  // arrives (e.g. the PeerTube poll takes up to 5 s to fire its first
  // status event).
  if (status.value) return;
  try {
    status.value = await endpoints.peertubeStatus();
    error.value = null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    status.value = null;
  }
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
