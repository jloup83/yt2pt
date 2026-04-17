import { test } from "node:test";
import assert from "node:assert/strict";
import { renderVideosTable, type VideoRow } from "./table";

const NOW = new Date("2026-04-17T12:00:00.000Z");

function row(partial: Partial<VideoRow>): VideoRow {
  return {
    id: 1,
    status: "UPLOADED",
    channel_name: "Channel",
    title: "Title",
    updated_at: NOW.toISOString(),
    ...partial,
  };
}

test("renders header and separator", () => {
  const text = renderVideosTable([row({})], NOW);
  const lines = text.split("\n");
  assert.match(lines[0], /ID\s+Status/);
  assert.match(lines[1], /─+/);
  assert.equal(lines.length, 3);
});

test("renders multiple rows with aligned id column", () => {
  const text = renderVideosTable(
    [row({ id: 1 }), row({ id: 999 })],
    NOW,
  );
  const dataLines = text.split("\n").slice(2);
  // Both id cells should be width 3 (length of "999"), so row with id=1
  // starts with "1  " (one space padding + two separator spaces).
  assert.match(dataLines[0], /^1  /);
  assert.match(dataLines[1], /^999/);
});

test("truncates long titles", () => {
  const longTitle = "x".repeat(200);
  const text = renderVideosTable([row({ title: longTitle })], NOW);
  assert.ok(!text.includes("x".repeat(200)));
  assert.match(text, /…/);
});

test("renders '—' for null channel name", () => {
  const text = renderVideosTable([row({ channel_name: null })], NOW);
  assert.match(text, /—/);
});

test("shows progress percent for UPLOADING rows", () => {
  const text = renderVideosTable([row({ status: "UPLOADING", progress_pct: 45 })], NOW);
  assert.match(text, /UPLOADING 45%/);
});
