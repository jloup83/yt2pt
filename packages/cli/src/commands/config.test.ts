import { test } from "node:test";
import assert from "node:assert/strict";
import { coerceValue, formatConfig } from "./config";

test("coerceValue parses booleans", () => {
  assert.equal(coerceValue("true"), true);
  assert.equal(coerceValue("false"), false);
});

test("coerceValue parses integers", () => {
  assert.equal(coerceValue("42"), 42);
  assert.equal(coerceValue("-7"), -7);
});

test("coerceValue leaves other strings alone", () => {
  assert.equal(coerceValue("public"), "public");
  assert.equal(coerceValue("1.5"), "1.5");
  assert.equal(coerceValue(""), "");
});

test("formatConfig groups by section", () => {
  const cfg = {
    http: { port: 8090, bind: "0.0.0.0" },
    peertube: { privacy: "public" },
  };
  const text = formatConfig(cfg);
  assert.match(text, /\[http\]/);
  assert.match(text, /port\s+=\s+8090/);
  assert.match(text, /\[peertube\]/);
  assert.match(text, /privacy\s+=\s+public/);
});
