import { test } from "node:test";
import assert from "node:assert/strict";
import { relativeTime } from "./time";

const NOW = new Date("2026-04-17T12:00:00.000Z");

test("'just now' for <30s delta", () => {
  assert.equal(relativeTime(new Date(NOW.getTime() - 5_000), NOW), "just now");
});

test("seconds", () => {
  assert.equal(relativeTime(new Date(NOW.getTime() - 45_000), NOW), "45 s ago");
});

test("minutes", () => {
  assert.equal(relativeTime(new Date(NOW.getTime() - 5 * 60_000), NOW), "5 min ago");
});

test("hours", () => {
  assert.equal(relativeTime(new Date(NOW.getTime() - 3 * 3_600_000), NOW), "3 h ago");
});

test("days", () => {
  assert.equal(relativeTime(new Date(NOW.getTime() - 3 * 86_400_000), NOW), "3 d ago");
});

test("months", () => {
  assert.equal(relativeTime(new Date(NOW.getTime() - 90 * 86_400_000), NOW), "3 mo ago");
});

test("years", () => {
  assert.equal(relativeTime(new Date(NOW.getTime() - 2 * 365 * 86_400_000), NOW), "2 y ago");
});

test("future timestamps fall back to ISO string", () => {
  const future = new Date(NOW.getTime() + 60_000);
  const s = relativeTime(future, NOW);
  assert.match(s, /T/);
});

test("invalid input is echoed", () => {
  assert.equal(relativeTime("not-a-date", NOW), "not-a-date");
});
