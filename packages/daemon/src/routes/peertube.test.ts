import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "../db/schema";
import { buildServer } from "../server";
import { fetchUserChannels } from "./peertube";
import { PeertubeConnection } from "../peertube/connection";
import type { Config, Logger, ResolvedPaths } from "@yt2pt/shared";

// ── Fixtures ────────────────────────────────────────────────────────

function makeConfig(token = "tok"): Config {
  return {
    yt2pt: {
      data_dir: "/tmp",
      log_dir: "/tmp",
      log_level: "info",
      overwrite_existing: false,
      skip_downloaded: true,
      remove_video_after_upload: false,
      remove_video_after_metadata_conversion: false,
    },
    http: { port: 8090, bind: "0.0.0.0" },
    workers: { download_concurrency: 1, convert_concurrency: 1, upload_concurrency: 1 },
    ytdlp: { format: "bv*+ba/b", merge_output_format: "mkv", thumbnail_format: "jpg" },
    peertube: {
      instance_url: "https://peertube.example",
      api_token: token,
      channel_id: "",
      privacy: "public",
      language: "",
      licence: "",
      comments_policy: "enabled",
      wait_transcoding: true,
      generate_transcription: true,
    },
  };
}

interface TestCtx {
  config: Config;
  paths: ResolvedPaths;
  db: Database.Database;
  logger: Logger;
  peertube?: PeertubeConnection;
  cleanup: () => void;
}

function makeCtx(peertube?: PeertubeConnection, token = "tok"): TestCtx {
  const dir = mkdtempSync(join(tmpdir(), "yt2pt-peertube-"));
  const configPath = join(dir, "yt2pt.conf.toml");
  writeFileSync(configPath, "", "utf-8");

  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as unknown as Logger;
  const paths: ResolvedPaths = { mode: "dev", configPath, dataDir: dir, logDir: dir, binDir: dir };

  return {
    config: makeConfig(token),
    paths,
    db,
    logger,
    peertube,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Build a real PeertubeConnection with an injected fetch and seeded state. */
function makeFakePeertube(
  config: Config,
  logger: Logger,
  fetchImpl: typeof fetch,
  opts: { online?: boolean; authenticated?: boolean; username?: string | null } = {}
): PeertubeConnection {
  const conn = new PeertubeConnection({ config, logger, fetch: fetchImpl });
  // Use internals to seed state without making live HTTP calls.
  const asAny = conn as unknown as {
    online: boolean;
    authenticated: boolean;
    username: string | null;
  };
  asAny.online = opts.online ?? true;
  asAny.authenticated = opts.authenticated ?? true;
  asAny.username = opts.username ?? "admin";
  return conn;
}

// ── fetchUserChannels ───────────────────────────────────────────────

test("fetchUserChannels maps and sorts video channels by displayName", async () => {
  const config = makeConfig();
  const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as unknown as Logger;
  const fakeFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        videoChannels: [
          { id: 7, name: "zebra", displayName: "Zebra" },
          { id: 2, name: "alpha", displayName: "Alpha" },
          { id: 5, name: "midway" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  const conn = makeFakePeertube(config, logger, fakeFetch);
  const channels = await fetchUserChannels(conn);
  assert.deepEqual(channels.map((c) => c.displayName), ["Alpha", "midway", "Zebra"]);
  assert.equal(channels[2].id, 7);
  // Fallback when displayName is missing.
  assert.equal(channels[1].displayName, "midway");
});

test("fetchUserChannels throws on non-ok response", async () => {
  const config = makeConfig();
  const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as unknown as Logger;
  const fakeFetch: typeof fetch = async () => new Response("", { status: 500 });
  const conn = makeFakePeertube(config, logger, fakeFetch);
  await assert.rejects(() => fetchUserChannels(conn), /users\/me returned 500/);
});

// ── Route: GET /api/peertube/status ─────────────────────────────────

test("GET /api/peertube/status returns sentinel when peertube not wired", async () => {
  const ctx = makeCtx(undefined);
  const app = buildServer(ctx);
  const res = await app.inject({ method: "GET", url: "/api/peertube/status" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    online: false,
    authenticated: false,
    instance_url: "https://peertube.example",
    username: null,
  });
  await app.close();
  ctx.cleanup();
});

test("GET /api/peertube/status returns connection getStatus()", async () => {
  const config = makeConfig();
  const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as unknown as Logger;
  const conn = makeFakePeertube(config, logger, (async () => new Response()) as typeof fetch, {
    online: true,
    authenticated: true,
    username: "alice",
  });
  const ctx = makeCtx(conn);
  ctx.config = config; // share the same config instance the conn reads from
  const app = buildServer({ ...ctx, config });
  const res = await app.inject({ method: "GET", url: "/api/peertube/status" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    online: true,
    authenticated: true,
    instance_url: "https://peertube.example",
    username: "alice",
  });
  await app.close();
  ctx.cleanup();
});

// ── Route: GET /api/peertube/channels ───────────────────────────────

test("GET /api/peertube/channels returns 503 when peertube not wired", async () => {
  const ctx = makeCtx(undefined);
  const app = buildServer(ctx);
  const res = await app.inject({ method: "GET", url: "/api/peertube/channels" });
  assert.equal(res.statusCode, 503);
  await app.close();
  ctx.cleanup();
});

test("GET /api/peertube/channels returns 401 when not authenticated", async () => {
  const config = makeConfig();
  const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as unknown as Logger;
  const conn = makeFakePeertube(config, logger, (async () => new Response()) as typeof fetch, {
    online: true,
    authenticated: false,
  });
  const ctx = makeCtx(conn);
  const app = buildServer({ ...ctx, config });
  const res = await app.inject({ method: "GET", url: "/api/peertube/channels" });
  assert.equal(res.statusCode, 401);
  await app.close();
  ctx.cleanup();
});

test("GET /api/peertube/channels returns channels and caches the result", async () => {
  const config = makeConfig();
  const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as unknown as Logger;
  let callCount = 0;
  const fakeFetch: typeof fetch = async () => {
    callCount++;
    return new Response(
      JSON.stringify({
        videoChannels: [
          { id: 1, name: "main", displayName: "Main Channel" },
          { id: 5, name: "gaming", displayName: "Gaming" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  const conn = makeFakePeertube(config, logger, fakeFetch);
  const ctx = makeCtx(conn);
  const app = buildServer({ ...ctx, config });

  const r1 = await app.inject({ method: "GET", url: "/api/peertube/channels" });
  assert.equal(r1.statusCode, 200);
  const b1 = r1.json();
  assert.equal(b1.cached, false);
  assert.equal(b1.channels.length, 2);
  assert.deepEqual(b1.channels[0], { id: 5, name: "gaming", displayName: "Gaming" });

  const r2 = await app.inject({ method: "GET", url: "/api/peertube/channels" });
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.json().cached, true);
  assert.equal(callCount, 1);

  // Force refresh.
  const r3 = await app.inject({ method: "GET", url: "/api/peertube/channels?refresh=1" });
  assert.equal(r3.statusCode, 200);
  assert.equal(r3.json().cached, false);
  assert.equal(callCount, 2);

  await app.close();
  ctx.cleanup();
});

test("GET /api/peertube/channels returns 502 when the upstream call fails", async () => {
  const config = makeConfig();
  const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as unknown as Logger;
  const fakeFetch: typeof fetch = async () => new Response("boom", { status: 500 });
  const conn = makeFakePeertube(config, logger, fakeFetch);
  const ctx = makeCtx(conn);
  const app = buildServer({ ...ctx, config });
  const res = await app.inject({ method: "GET", url: "/api/peertube/channels" });
  assert.equal(res.statusCode, 502);
  await app.close();
  ctx.cleanup();
});

// ── POST /api/peertube/channels/create-from-youtube ─────────────────

import { writeFileSync as _writeFileSync, mkdirSync as _mkdirSync } from "node:fs";
import { join as _join } from "node:path";

test("POST /api/peertube/channels/create-from-youtube validates URL + auth", async () => {
  const config = makeConfig();
  const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as unknown as Logger;
  const conn = makeFakePeertube(config, logger, async () => new Response("", { status: 200 }));
  const ctx = makeCtx(conn);
  const app = buildServer({ ...ctx, config });

  // Missing url
  let res = await app.inject({
    method: "POST", url: "/api/peertube/channels/create-from-youtube", payload: {},
  });
  assert.equal(res.statusCode, 400);

  // Bad url
  res = await app.inject({
    method: "POST", url: "/api/peertube/channels/create-from-youtube",
    payload: { youtube_url: "https://example.com/foo" },
  });
  assert.equal(res.statusCode, 400);

  await app.close();
  ctx.cleanup();
});

test("POST /api/peertube/channels/create-from-youtube returns 401 when not authenticated", async () => {
  const config = makeConfig();
  const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as unknown as Logger;
  const conn = makeFakePeertube(config, logger, async () => new Response("", { status: 200 }), {
    authenticated: false,
  });
  const ctx = makeCtx(conn);
  const app = buildServer({ ...ctx, config });
  const res = await app.inject({
    method: "POST", url: "/api/peertube/channels/create-from-youtube",
    payload: { youtube_url: "https://www.youtube.com/@foo" },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
  ctx.cleanup();
});

test("POST /api/peertube/channels/create-from-youtube wires fetcher → creator → mapping", async () => {
  const config = makeConfig();
  const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as unknown as Logger;
  const conn = makeFakePeertube(config, logger, async () => new Response("", { status: 200 }));
  const ctx = makeCtx(conn);

  // Stub channel-info fetcher: write a metadata.json into the temp dir
  // and return its path so the orchestrator can read it back.
  const infoDir = _join(ctx.paths.dataDir, "downloaded_from_youtube", "foo", "channel_info");
  _mkdirSync(infoDir, { recursive: true });
  const metaPath = _join(infoDir, "metadata.json");
  _writeFileSync(metaPath, JSON.stringify({
    channel: "Foo Channel",
    channel_url: "https://www.youtube.com/@foo",
  }), "utf-8");

  const fakeFetcher = async () => ({
    slug: "foo",
    dir: infoDir,
    metadataPath: metaPath,
    avatarPath: null,
    bannerPath: null,
  });
  const fakeCreator = async (args: { overrides?: { name?: string } }) => ({
    payload: {
      name: args.overrides?.name ?? "foo_channel",
      displayName: "Foo Channel",
      description: "",
      support: "",
    },
    staged: { dir: "/tmp", metadataPath: "/tmp/m.json", avatarPath: null, bannerPath: null },
    created: { id: 42, name: args.overrides?.name ?? "foo_channel", displayName: "Foo Channel" },
    warnings: [],
  });

  const app = buildServer({
    ...ctx, config,
    channelInfoFetcher: fakeFetcher as unknown as ServerCtxFetcher,
    ptChannelCreator: fakeCreator as unknown as ServerCtxCreator,
  });

  const res = await app.inject({
    method: "POST", url: "/api/peertube/channels/create-from-youtube",
    payload: { youtube_url: "https://www.youtube.com/@foo" },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.peertube_channel.id, 42);
  assert.equal(body.mapping.peertube_channel_id, "42");
  assert.equal(body.mapping.youtube_channel_url, "https://www.youtube.com/@foo");

  // Mapping persisted in the DB.
  const row = ctx.db.prepare("SELECT * FROM channels").all();
  assert.equal(row.length, 1);

  await app.close();
  ctx.cleanup();
});

test("POST /api/peertube/channels/create-from-youtube returns 409 on PT slug conflict", async () => {
  const config = makeConfig();
  const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as unknown as Logger;
  const conn = makeFakePeertube(config, logger, async () => new Response("", { status: 200 }));
  const ctx = makeCtx(conn);

  const infoDir = _join(ctx.paths.dataDir, "downloaded_from_youtube", "foo", "channel_info");
  _mkdirSync(infoDir, { recursive: true });
  const metaPath = _join(infoDir, "metadata.json");
  _writeFileSync(metaPath, JSON.stringify({ channel: "Foo" }), "utf-8");

  const fakeFetcher = async () => ({
    slug: "foo", dir: infoDir, metadataPath: metaPath,
    avatarPath: null, bannerPath: null,
  });
  const { PeertubeApiError } = await import("../peertube/create-channel");
  const fakeCreator = async () => {
    throw new PeertubeApiError("slug taken", 409, { code: "channel_name_already_exists" });
  };

  const app = buildServer({
    ...ctx, config,
    channelInfoFetcher: fakeFetcher as unknown as ServerCtxFetcher,
    ptChannelCreator: fakeCreator as unknown as ServerCtxCreator,
  });
  const res = await app.inject({
    method: "POST", url: "/api/peertube/channels/create-from-youtube",
    payload: { youtube_url: "https://www.youtube.com/@foo", overrides: { name: "foo" } },
  });
  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(body.peertube_status, 409);
  assert.equal(body.attempted_slug, "foo");

  // No mapping was persisted on failure.
  const rows = ctx.db.prepare("SELECT * FROM channels").all();
  assert.equal(rows.length, 0);

  await app.close();
  ctx.cleanup();
});

test("POST /api/peertube/channels/create-from-youtube refuses duplicate yt2pt mapping", async () => {
  const config = makeConfig();
  const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as unknown as Logger;
  const conn = makeFakePeertube(config, logger, async () => new Response("", { status: 200 }));
  const ctx = makeCtx(conn);

  // Pre-existing mapping for the same URL.
  const { insertChannel } = await import("../db/channels");
  insertChannel(ctx.db, {
    youtube_channel_url: "https://www.youtube.com/@foo",
    peertube_channel_id: "7",
  });

  const app = buildServer({ ...ctx, config });
  const res = await app.inject({
    method: "POST", url: "/api/peertube/channels/create-from-youtube",
    payload: { youtube_url: "https://www.youtube.com/@foo" },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().peertube_channel_id, "7");
  await app.close();
  ctx.cleanup();
});

// Type aliases for the test casts above (avoid pulling the route's
// internal types into this file).
type ServerCtxFetcher = NonNullable<Parameters<typeof buildServer>[0]["channelInfoFetcher"]>;
type ServerCtxCreator = NonNullable<Parameters<typeof buildServer>[0]["ptChannelCreator"]>;
