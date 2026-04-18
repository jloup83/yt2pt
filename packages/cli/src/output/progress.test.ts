import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBar, formatSnapshot, makeEmptySnapshot } from "./progress";

test("renderBar fills proportionally", () => {
  const bar = renderBar(5, 10, 10);
  assert.equal(bar, "[█████░░░░░]");
});

test("renderBar full", () => {
  assert.equal(renderBar(10, 10, 10), "[██████████]");
});

test("renderBar empty on zero total", () => {
  assert.equal(renderBar(0, 0, 5), "[     ]");
});

test("renderBar clamps ratio to [0,1]", () => {
  assert.equal(renderBar(-5, 10, 4), "[░░░░]");
  assert.equal(renderBar(50, 10, 4), "[████]");
});

test("formatSnapshot contains all three phases and no-color has no ANSI", () => {
  const snap = makeEmptySnapshot("My Channel");
  snap.discovered = 42;
  snap.new_videos = 10;
  snap.already_tracked = 32;
  snap.downloading = { done: 3, total: 10, current: "a title" };
  snap.converting = { done: 1, total: 10, current: "another" };
  snap.uploading = { done: 0, total: 10, current: null };

  const text = formatSnapshot(snap, false);
  assert.match(text, /My Channel/);
  assert.match(text, /Found 42 videos \(10 new, 32 already tracked\)/);
  assert.match(text, /Downloading:.*3\/10/);
  assert.match(text, /Converting:.*1\/10/);
  assert.match(text, /Uploading:.*0\/10/);
  assert.doesNotMatch(text, /\x1b\[/);
});
