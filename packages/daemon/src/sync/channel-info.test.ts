import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchChannelInfo,
  pickAvatar,
  pickBanner,
  imageExtFromUrl,
} from "./channel-info";

// Minimal Logger stub matching the shared Logger shape used by fetchChannelInfo.
function makeLogger(): {
  error: (m: string) => void;
  info: (m: string) => void;
  debug: (m: string) => void;
  errors: string[];
  infos: string[];
  debugs: string[];
} {
  const errors: string[] = [];
  const infos: string[] = [];
  const debugs: string[] = [];
  return {
    error: (m) => { errors.push(m); },
    info:  (m) => { infos.push(m); },
    debug: (m) => { debugs.push(m); },
    errors,
    infos,
    debugs,
  };
}

describe("channel-info helpers", () => {
  it("imageExtFromUrl() returns jpg/png/webp/gif, normalising jpeg→jpg", () => {
    assert.equal(imageExtFromUrl("https://x/y/pic.jpg"), "jpg");
    assert.equal(imageExtFromUrl("https://x/y/pic.JPEG?foo=1"), "jpg");
    assert.equal(imageExtFromUrl("https://x/y/pic.png"), "png");
    assert.equal(imageExtFromUrl("https://x/y/pic.webp"), "webp");
    assert.equal(imageExtFromUrl("https://x/y/pic.gif?v=2"), "gif");
    assert.equal(imageExtFromUrl("https://x/y/no-ext"), null);
  });

  it("pickAvatar() prefers the id 'avatar_uncropped'", () => {
    const thumbs = [
      { id: "avatars",           url: "https://x/avatar_small.jpg",  width: 48,  height: 48  },
      { id: "avatar_uncropped",  url: "https://x/avatar_big.jpg",    width: 900, height: 900 },
    ];
    assert.equal(pickAvatar(thumbs), "https://x/avatar_big.jpg");
  });

  it("pickAvatar() falls back to square thumbnails when ids are absent", () => {
    const thumbs = [
      { id: "banner_uncropped", url: "https://x/banner.jpg", width: 2000, height: 350 },
      { id: "thumb-1",          url: "https://x/square1.jpg", width: 176, height: 176 },
      { id: "thumb-2",          url: "https://x/square2.jpg", width: 900, height: 900 },
    ];
    assert.equal(pickAvatar(thumbs), "https://x/square2.jpg");
  });

  it("pickAvatar() returns null when no candidate exists", () => {
    assert.equal(pickAvatar([]), null);
    assert.equal(pickAvatar([{ id: "banner", url: "https://x/b.jpg", width: 2000, height: 350 }]), null);
  });

  it("pickBanner() prefers the id 'banner_uncropped' and picks the widest", () => {
    const thumbs = [
      { id: "banner",            url: "https://x/banner_small.jpg",  width: 1060, height: 175 },
      { id: "banner_uncropped",  url: "https://x/banner_huge.jpg",   width: 2560, height: 1440 },
    ];
    assert.equal(pickBanner(thumbs), "https://x/banner_huge.jpg");
  });

  it("pickBanner() returns null when no candidate exists", () => {
    assert.equal(pickBanner([]), null);
    assert.equal(pickBanner([{ id: "avatar_uncropped", url: "https://x/a.jpg", width: 900, height: 900 }]), null);
  });
});

describe("fetchChannelInfo()", () => {
  let tmp: string;
  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "yt2pt-channel-info-"));
  });
  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const sampleMeta = {
    id: "UC_test",
    channel: "Some Channel",
    uploader: "some-channel",
    title: "Some Channel - Videos",
    description: "hello",
    thumbnails: [
      { id: "avatar_uncropped", url: "https://img.example/avatar.jpg",  width: 900,  height: 900  },
      { id: "banner_uncropped", url: "https://img.example/banner.webp", width: 2560, height: 1440 },
    ],
  };

  it("writes metadata.json, avatar, banner using the sanitized slug", async () => {
    const logger = makeLogger();
    const downloaded: Array<{ url: string; dest: string }> = [];

    const result = await fetchChannelInfo({
      ytdlp: "/stub/yt-dlp",
      channelUrl: "https://www.youtube.com/@SomeChannel",
      dataDir: tmp,
      logger: logger as unknown as import("@yt2pt/shared").Logger,
      runYtdlp: async (_bin, args) => {
        assert.ok(args.includes("--dump-single-json"), "uses --dump-single-json");
        assert.ok(args.includes("--flat-playlist"), "uses --flat-playlist");
        assert.ok(args.includes("--playlist-items"), "uses --playlist-items");
        assert.ok(args.includes("0"), "playlist-items value is 0");
        assert.ok(args[args.length - 1]!.includes("youtube.com"), "channel URL last");
        return JSON.stringify(sampleMeta);
      },
      downloadImage: async (url, dest) => {
        downloaded.push({ url, dest });
        await (await import("node:fs/promises")).writeFile(dest, "");
      },
    });

    // slug derives from the "channel" field ("Some Channel" → "some_channel")
    assert.equal(result.slug, "some_channel");
    const expectedDir = join(tmp, "downloaded_from_youtube", "some_channel", "channel_info");
    assert.equal(result.dir, expectedDir);

    // metadata.json written verbatim
    const meta = JSON.parse(await readFile(result.metadataPath, "utf-8")) as Record<string, unknown>;
    assert.deepEqual(meta, sampleMeta);

    // avatar + banner were downloaded with the right extensions
    assert.equal(result.avatarPath, join(expectedDir, "avatar.jpg"));
    assert.equal(result.bannerPath, join(expectedDir, "banner.webp"));
    assert.deepEqual(
      downloaded.sort((a, b) => a.url.localeCompare(b.url)),
      [
        { url: "https://img.example/avatar.jpg",  dest: join(expectedDir, "avatar.jpg")  },
        { url: "https://img.example/banner.webp", dest: join(expectedDir, "banner.webp") },
      ]
    );
    await stat(result.avatarPath!);
    await stat(result.bannerPath!);
  });

  it("is non-fatal when an image download fails: returns null path, logs error", async () => {
    const logger = makeLogger();
    const result = await fetchChannelInfo({
      ytdlp: "/stub/yt-dlp",
      channelUrl: "https://www.youtube.com/@X",
      dataDir: tmp,
      logger: logger as unknown as import("@yt2pt/shared").Logger,
      runYtdlp: async () => JSON.stringify(sampleMeta),
      downloadImage: async (url) => {
        if (url.includes("banner")) throw new Error("network down");
        // avatar succeeds — write a placeholder
        const dest = join(
          tmp, "downloaded_from_youtube", "some_channel", "channel_info",
          "avatar.jpg"
        );
        const { writeFile } = await import("node:fs/promises");
        await writeFile(dest, "");
      },
    });

    assert.ok(result.avatarPath);
    assert.equal(result.bannerPath, null);
    assert.ok(
      logger.errors.some((m) => m.includes("banner download failed")),
      "expected an error log for banner failure"
    );
  });

  it("throws when yt-dlp returns invalid JSON", async () => {
    const logger = makeLogger();
    await assert.rejects(
      fetchChannelInfo({
        ytdlp: "/stub/yt-dlp",
        channelUrl: "https://www.youtube.com/@X",
        dataDir: tmp,
        logger: logger as unknown as import("@yt2pt/shared").Logger,
        runYtdlp: async () => "not json",
        downloadImage: async () => { /* noop */ },
      }),
      /failed to parse yt-dlp channel JSON/
    );
  });

  it("throws when yt-dlp returns metadata with no channel/uploader/title", async () => {
    const logger = makeLogger();
    await assert.rejects(
      fetchChannelInfo({
        ytdlp: "/stub/yt-dlp",
        channelUrl: "https://www.youtube.com/@X",
        dataDir: tmp,
        logger: logger as unknown as import("@yt2pt/shared").Logger,
        runYtdlp: async () => JSON.stringify({ id: "UC_x", thumbnails: [] }),
        downloadImage: async () => { /* noop */ },
      }),
      /did not include channel\/uploader\/title/
    );
  });

  it("skips avatar/banner when no suitable thumbnails exist", async () => {
    const logger = makeLogger();
    const downloaded: string[] = [];

    const result = await fetchChannelInfo({
      ytdlp: "/stub/yt-dlp",
      channelUrl: "https://www.youtube.com/@Y",
      dataDir: tmp,
      logger: logger as unknown as import("@yt2pt/shared").Logger,
      runYtdlp: async () => JSON.stringify({
        channel: "Plain",
        thumbnails: [],
      }),
      downloadImage: async (url) => { downloaded.push(url); },
    });

    assert.equal(result.avatarPath, null);
    assert.equal(result.bannerPath, null);
    assert.deepEqual(downloaded, []);
    // metadata.json still written
    await stat(result.metadataPath);
  });
});
