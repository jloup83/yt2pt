import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrame, parseSseData } from "./sse";

test("parseFrame parses event + data", () => {
  const f = parseFrame("event: video_status\ndata: {\"id\":1}");
  assert.deepEqual(f, { event: "video_status", data: '{"id":1}' });
});

test("parseFrame defaults event to 'message'", () => {
  const f = parseFrame("data: hello");
  assert.deepEqual(f, { event: "message", data: "hello" });
});

test("parseFrame joins multi-line data with \\n", () => {
  const f = parseFrame("event: x\ndata: line1\ndata: line2");
  assert.deepEqual(f, { event: "x", data: "line1\nline2" });
});

test("parseFrame ignores comment and retry lines", () => {
  const f = parseFrame(": ping 123\nretry: 5000\nevent: hello\ndata: {}");
  assert.deepEqual(f, { event: "hello", data: "{}" });
});

test("parseFrame returns null when no data line", () => {
  assert.equal(parseFrame("event: only\nretry: 1000"), null);
});

test("parseFrame strips single leading space per SSE spec", () => {
  const f = parseFrame("data:  two-spaces");
  // Only first space is stripped.
  assert.equal(f?.data, " two-spaces");
});

test("parseSseData parses JSON payloads", () => {
  const v = parseSseData<{ a: number }>({ event: "x", data: '{"a":1}' });
  assert.deepEqual(v, { a: 1 });
});

test("parseSseData returns raw string on parse failure", () => {
  const v = parseSseData({ event: "x", data: "not json" });
  assert.equal(v, "not json");
});
