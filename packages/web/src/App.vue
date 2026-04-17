<script setup lang="ts">
import NavBar from "./components/NavBar.vue";
</script>

<template>
  <NavBar />
  <main class="container">
    <RouterView />
  </main>
  <footer class="container">
    <small>
      <a href="https://github.com/jloup83/yt2pt" target="_blank" rel="noopener">yt2pt</a>
      &middot; v1.0.0-beta
    </small>
  </footer>
</template>

<style>
main.container {
  padding-block: 1.5rem;
}
footer.container {
  padding-block: 1rem;
  text-align: center;
  opacity: 0.7;
}
</style>
