import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConvert } from "./convert";
import type { Config, Logger } from "@yt2pt/shared";

function makeConfig(peertubeChannelId = ""): Config {
  return {
    yt2pt: {
      data_dir: "", log_dir: "", log_level: "info",
      overwrite_existing: false, skip_downloaded: true,
      remove_video_after_upload: false, remove_video_after_metadata_conversion: false,
    },
    http: { port: 8090, bind: "0.0.0.0" },
    workers: { download_concurrency: 1, convert_concurrency: 1, upload_concurrency: 1 },
    ytdlp: { format: "", merge_output_format: "mkv", thumbnail_format: "jpg" },
    peertube: {
      instance_url: "", api_token: "", channel_id: peertubeChannelId,
      privacy: "public", language: "", licence: "", comments_policy: "enabled",
      wait_transcoding: true, generate_transcription: true,
    },
  };
}

function silentLogger(): Logger {
  return {
    info: () => {}, error: () => {}, debug: () => {},
  } as unknown as Logger;
}

function setupSource(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const meta = {
    title: "A Test Video",
    description: "body",
    categories: ["Education"],
    tags: ["one", "two"],
    license: null,
    upload_date: "20260411",
    _ext: "mkv",
  };
  writeFileSync(join(dir, "metadata.json"), JSON.stringify(meta));
  writeFileSync(join(dir, "a-test-video.mkv"), "fake-video-bytes");
}

describe("runConvert channelId resolution (issue #94)", () => {
  it("writes options.peertubeChannelId into upload_video.json, ignoring the global config value", async () => {
    const root = mkdtempSync(join(tmpdir(), "convert-test-"));
    const src = join(root, "src");
    const dst = join(root, "dst");
    try {
      setupSource(src);
      // Per-channel id "5" should win over the (different) global config "999".
      await runConvert(src, dst, makeConfig("999"), silentLogger(), { peertubeChannelId: "5" });
      const written = JSON.parse(readFileSync(join(dst, "upload_video.json"), "utf-8"));
      assert.equal(written.channelId, "5", "per-channel id must be persisted, not the global fallback");
      assert.equal(written.name, "A Test Video");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws early when peertubeChannelId is empty (no work done)", async () => {
    const root = mkdtempSync(join(tmpdir(), "convert-test-"));
    const src = join(root, "src");
    const dst = join(root, "dst");
    try {
      setupSource(src);
      await assert.rejects(
        runConvert(src, dst, makeConfig(""), silentLogger(), { peertubeChannelId: "" }),
        /no peertube channel id/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
