import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";

const routes: RouteRecordRaw[] = [
  { path: "/", name: "home", component: () => import("./pages/HomePage.vue") },
  { path: "/activities", name: "activities", component: () => import("./pages/ActivitiesPage.vue") },
  { path: "/settings", name: "settings", component: () => import("./pages/SettingsPage.vue") },
  { path: "/:catchAll(.*)", redirect: "/" },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});
