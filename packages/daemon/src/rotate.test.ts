import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateLogFile } from "@yt2pt/shared";

function setup(): { dir: string; log: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rotate-test-"));
  const log = join(dir, "yt2pt.log");
  return { dir, log, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("rotateLogFile", () => {
  it("is a no-op when the live file is absent", () => {
    const { log, cleanup } = setup();
    try {
      rotateLogFile(log);
      assert.equal(existsSync(log), false);
      assert.equal(existsSync(`${log}.archive.1`), false);
    } finally { cleanup(); }
  });

  it("is a no-op when the live file is empty", () => {
    const { log, cleanup } = setup();
    try {
      writeFileSync(log, "");
      rotateLogFile(log);
      assert.equal(existsSync(log), true);
      assert.equal(existsSync(`${log}.archive.1`), false);
    } finally { cleanup(); }
  });

  it("rotates a non-empty live file to archive.1", () => {
    const { log, cleanup } = setup();
    try {
      writeFileSync(log, "first run\n");
      rotateLogFile(log);
      assert.equal(existsSync(log), false, "live file should have been moved");
      assert.equal(readFileSync(`${log}.archive.1`, "utf-8"), "first run\n");
    } finally { cleanup(); }
  });

  it("shifts existing archives (1→2, 2→3, …) before promoting live", () => {
    const { log, cleanup } = setup();
    try {
      writeFileSync(`${log}.archive.1`, "run -1\n");
      writeFileSync(`${log}.archive.2`, "run -2\n");
      writeFileSync(log, "current\n");
      rotateLogFile(log);
      assert.equal(readFileSync(`${log}.archive.1`, "utf-8"), "current\n");
      assert.equal(readFileSync(`${log}.archive.2`, "utf-8"), "run -1\n");
      assert.equal(readFileSync(`${log}.archive.3`, "utf-8"), "run -2\n");
      assert.equal(existsSync(log), false);
    } finally { cleanup(); }
  });

  it("caps retention at maxArchives (default 10)", () => {
    const { log, cleanup } = setup();
    try {
      for (let i = 1; i <= 10; i++) writeFileSync(`${log}.archive.${i}`, `run -${i}\n`);
      writeFileSync(log, "current\n");
      rotateLogFile(log, 10);
      // archive.10 existed and was dropped; the old archive.9 is now archive.10.
      assert.equal(existsSync(`${log}.archive.11`), false);
      assert.equal(readFileSync(`${log}.archive.10`, "utf-8"), "run -9\n");
      assert.equal(readFileSync(`${log}.archive.1`, "utf-8"), "current\n");
    } finally { cleanup(); }
  });
});
