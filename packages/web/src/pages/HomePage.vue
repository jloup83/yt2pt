<script setup lang="ts">
import { onMounted, ref } from "vue";
import { endpoints, type HealthResponse } from "../api";

const health = ref<HealthResponse | null>(null);
const err = ref<string | null>(null);

onMounted(async () => {
  try {
    health.value = await endpoints.health();
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  }
});
</script>

<template>
  <hgroup>
    <h1>Home</h1>
    <p>Channel mappings and pipeline overview.</p>
  </hgroup>

  <article>
    <header><strong>Daemon health</strong></header>
    <p v-if="err"><mark>{{ err }}</mark></p>
    <p v-else-if="health">
      Status: <code>{{ health.status }}</code> &middot; version:
      <code>{{ health.version }}</code>
    </p>
    <p v-else aria-busy="true">Checking…</p>
  </article>

  <p>
    Channels + sync controls land with
    <a href="https://github.com/jloup83/yt2pt/issues/65" target="_blank" rel="noopener">#65</a>.
  </p>
</template>
