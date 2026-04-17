<script setup lang="ts">
import { RouterLink } from "vue-router";
import StatusIndicator from "./StatusIndicator.vue";
</script>

<template>
  <nav class="container">
    <ul>
      <li>
        <strong>yt2pt</strong>
      </li>
    </ul>
    <ul>
      <li><RouterLink to="/">Home</RouterLink></li>
      <li><RouterLink to="/activities">Activities</RouterLink></li>
      <li><RouterLink to="/settings">Settings</RouterLink></li>
      <li><StatusIndicator /></li>
    </ul>
  </nav>
</template>

<style scoped>
nav :deep(a.router-link-exact-active) {
  text-decoration: underline;
  font-weight: 600;
}
</style>
