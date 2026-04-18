import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolvePaths } from "@yt2pt/shared";

/**
 * These tests rely on dev-mode detection: on macOS the resolver always
 * returns dev mode; on Linux it returns dev mode when `yt2pt.toml`
 * exists at the repo root (which it does in this workspace).
 */
describe("resolvePaths() zero-config defaults", () => {
  const savedData = process.env["YT2PT_DATA_DIR"];
  const savedLog = process.env["YT2PT_LOG_DIR"];
  const savedConfig = process.env["YT2PT_CONFIG"];

  before(() => {
    delete process.env["YT2PT_DATA_DIR"];
    delete process.env["YT2PT_LOG_DIR"];
    delete process.env["YT2PT_CONFIG"];
  });
  after(() => {
    if (savedData !== undefined) process.env["YT2PT_DATA_DIR"] = savedData;
    if (savedLog !== undefined) process.env["YT2PT_LOG_DIR"] = savedLog;
    if (savedConfig !== undefined) process.env["YT2PT_CONFIG"] = savedConfig;
  });

  it("dev mode uses ~/.local/share/yt2pt for data and logs", () => {
    const p = resolvePaths();
    const home = homedir();
    assert.equal(p.mode, "dev");
    assert.equal(p.dataDir, join(home, ".local", "share", "yt2pt"));
    assert.equal(p.logDir, join(home, ".local", "share", "yt2pt", "logs"));
    assert.notEqual(p.dataDir, p.logDir, "data and log dirs must not collapse");
  });

  it("config overrides still win over defaults", () => {
    const p = resolvePaths({ data_dir: "/var/lib/custom", log_dir: "/var/log/custom" });
    assert.equal(p.dataDir, "/var/lib/custom");
    assert.equal(p.logDir, "/var/log/custom");
  });

  it("env overrides win over defaults when no config override is present", () => {
    process.env["YT2PT_DATA_DIR"] = "/env/data";
    process.env["YT2PT_LOG_DIR"] = "/env/logs";
    try {
      const p = resolvePaths();
      assert.equal(p.dataDir, "/env/data");
      assert.equal(p.logDir, "/env/logs");
    } finally {
      delete process.env["YT2PT_DATA_DIR"];
      delete process.env["YT2PT_LOG_DIR"];
    }
  });
});
