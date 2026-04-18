import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPeertubeChannelPayload,
  slugifyForPeertube,
  stagePeertubeChannelAssets,
  PeertubeApiError,
} from "./create-channel";

// ── slugifyForPeertube ──────────────────────────────────────────────

test("slugifyForPeertube produces [a-z0-9_.] within 50 chars", () => {
  assert.equal(slugifyForPeertube("Some Channel"), "some_channel");
  assert.equal(slugifyForPeertube("Café Brûlé"), "cafe_brule");
  assert.equal(slugifyForPeertube("@Han.dle-99"), "han.dle_99");
  assert.equal(slugifyForPeertube("***"), "channel"); // empty fallback
  const long = "x".repeat(200);
  assert.equal(slugifyForPeertube(long).length, 50);
});

test("slugifyForPeertube collapses runs and strips edge punctuation", () => {
  assert.equal(slugifyForPeertube("___foo...bar___"), "foo_bar");
  assert.equal(slugifyForPeertube("a   b   c"), "a_b_c");
});

// ── buildPeertubeChannelPayload ─────────────────────────────────────

test("buildPeertubeChannelPayload derives slug + caps description", () => {
  const meta = {
    channel: "Cool Creator",
    channel_url: "https://www.youtube.com/@CoolCreator",
    description: "x".repeat(2000),
  };
  const p = buildPeertubeChannelPayload(meta);
  assert.equal(p.name, "cool_creator");
  assert.equal(p.displayName, "Cool Creator");
  assert.equal(p.description.length, 1000);
  assert.match(p.support, /Mirrored from https:\/\/www\.youtube\.com\/@CoolCreator/);
});

test("buildPeertubeChannelPayload uses uploader_id handle for slug, channel for displayName", () => {
  // Mirrors a real yt-dlp dump for https://www.youtube.com/@hekima01
  const meta = {
    channel: "HEKIMA",
    uploader: "HEKIMA",
    uploader_id: "@hekima01",
    uploader_url: "https://www.youtube.com/@hekima01",
    channel_url: "https://www.youtube.com/channel/UChtdytjf7RxHcB8s2yb_AXg",
  };
  const p = buildPeertubeChannelPayload(meta);
  assert.equal(p.name, "hekima01");
  assert.equal(p.displayName, "HEKIMA");
});

test("buildPeertubeChannelPayload honours overrides and re-validates slug", () => {
  const meta = { channel: "Cool Creator" };
  const p = buildPeertubeChannelPayload(meta, {
    name: "custom_slug",
    displayName: "Custom Display",
    description: "Hello",
    support: "thanks",
  });
  assert.equal(p.name, "custom_slug");
  assert.equal(p.displayName, "Custom Display");
  assert.equal(p.description, "Hello");
  assert.equal(p.support, "thanks");
});

test("buildPeertubeChannelPayload rejects an invalid override slug", () => {
  assert.throws(
    () => buildPeertubeChannelPayload({ channel: "x" }, { name: "Bad Slug!" }),
    /invalid PeerTube channel slug/,
  );
});

test("buildPeertubeChannelPayload handles missing fields with defaults", () => {
  const p = buildPeertubeChannelPayload({});
  assert.equal(p.name, "channel");
  assert.equal(p.displayName, "channel");
  assert.equal(p.description, "");
});

// ── stagePeertubeChannelAssets ──────────────────────────────────────

test("stagePeertubeChannelAssets writes metadata + copies images", async () => {
  const root = mkdtempSync(join(tmpdir(), "yt2pt-stage-"));
  try {
    // Source channel_info dir with avatar + banner.
    const srcDir = join(root, "downloaded_from_youtube", "foo", "channel_info");
    mkdirSync(srcDir, { recursive: true });
    const srcAvatar = join(srcDir, "avatar.jpg");
    const srcBanner = join(srcDir, "banner.png");
    writeFileSync(srcAvatar, "AVATAR");
    writeFileSync(srcBanner, "BANNER");

    const payload = {
      name: "foo", displayName: "Foo", description: "d", support: "s",
    };
    const staged = await stagePeertubeChannelAssets(root, "foo", payload, {
      avatar: srcAvatar, banner: srcBanner,
    });

    assert.match(staged.dir, /upload_to_peertube\/foo\/channel_info$/);
    assert.equal(JSON.parse(readFileSync(staged.metadataPath, "utf-8")).name, "foo");
    assert.ok(staged.avatarPath?.endsWith("avatar.jpg"));
    assert.ok(staged.bannerPath?.endsWith("banner.png"));
    assert.equal(readFileSync(staged.avatarPath!, "utf-8"), "AVATAR");
    assert.equal(readFileSync(staged.bannerPath!, "utf-8"), "BANNER");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stagePeertubeChannelAssets tolerates missing avatar/banner", async () => {
  const root = mkdtempSync(join(tmpdir(), "yt2pt-stage-"));
  try {
    const staged = await stagePeertubeChannelAssets(
      root, "bar",
      { name: "bar", displayName: "Bar", description: "", support: "" },
      { avatar: null, banner: null },
    );
    assert.equal(staged.avatarPath, null);
    assert.equal(staged.bannerPath, null);
    assert.ok(staged.metadataPath.endsWith("metadata.json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── PeertubeApiError ────────────────────────────────────────────────

test("PeertubeApiError carries status + body", () => {
  const e = new PeertubeApiError("nope", 409, { code: "channel_name_already_exists" });
  assert.equal(e.status, 409);
  assert.deepEqual(e.body, { code: "channel_name_already_exists" });
  assert.equal(e.name, "PeertubeApiError");
});
