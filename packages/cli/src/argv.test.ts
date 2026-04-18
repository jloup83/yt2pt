import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "./argv";

test("parses positional-only args", () => {
  const r = parseArgs(["status"]);
  assert.deepEqual(r.positional, ["status"]);
  assert.deepEqual(r.flags, {});
});

test("parses mixed positional and subcommand", () => {
  const r = parseArgs(["channels", "add", "https://youtube.com/@x", "42"]);
  assert.deepEqual(r.positional, ["channels", "add", "https://youtube.com/@x", "42"]);
});

test("parses boolean flags", () => {
  const r = parseArgs(["videos", "--json"]);
  assert.deepEqual(r.positional, ["videos"]);
  assert.equal(r.flags.json, true);
});

test("parses long flag with = value", () => {
  const r = parseArgs(["videos", "--status=UPLOADING"]);
  assert.equal(r.flags.status, "UPLOADING");
});

test("parses long flag with space value", () => {
  const r = parseArgs(["videos", "--status", "UPLOADING"]);
  assert.equal(r.flags.status, "UPLOADING");
});

test("parses --daemon-url", () => {
  const r = parseArgs(["status", "--daemon-url=http://host:1234"]);
  assert.equal(r.flags["daemon-url"], "http://host:1234");
});

test("-h is alias for --help", () => {
  const r = parseArgs(["-h"]);
  assert.equal(r.flags.help, true);
});

test("-v is alias for --version", () => {
  const r = parseArgs(["-v"]);
  assert.equal(r.flags.version, true);
});

test("throws on unknown flag", () => {
  assert.throws(() => parseArgs(["--wat"]), /unknown flag/);
});

test("throws when value flag has no value", () => {
  assert.throws(() => parseArgs(["--status"]), /requires a value/);
});

test("--no-watch is a boolean flag", () => {
  const r = parseArgs(["channels", "sync", "1", "--no-watch"]);
  assert.equal(r.flags["no-watch"], true);
});
