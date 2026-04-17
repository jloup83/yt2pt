import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, Logger } from "@yt2pt/shared";
import { PeertubeConnection } from "./connection";

function silentLogger(): Logger {
  return { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as unknown as Logger;
}

function baseConfig(token = ""): Config {
  return {
    yt2pt: { data_dir: "/tmp", log_dir: "/tmp", log_level: "error" },
    http: { port: 0, bind: "127.0.0.1" },
    workers: { download_concurrency: 1, convert_concurrency: 1, upload_concurrency: 1 },
    ytdlp: { format: "", merge_output_format: "", thumbnail_format: "" },
    peertube: {
      instance_url: "https://peertube.example",
      api_token: token,
      channel_id: "1",
      privacy: "public",
      language: "",
      licence: "",
      comments_policy: "enabled",
      wait_transcoding: false,
      generate_transcription: false,
    },
  } as unknown as Config;
}

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function fakeFetch(routes: Record<string, Handler>): typeof fetch {
  return async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const key = `${(init.method ?? "GET").toUpperCase()} ${url.pathname}`;
    const handler = routes[key];
    if (!handler) {
      return new Response("unmatched", { status: 599 });
    }
    return handler(url, init);
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

// ── Online ──────────────────────────────────────────────────────────

test("checkOnline: true when /api/v1/config responds 200", async () => {
  const conn = new PeertubeConnection({
    config: baseConfig(),
    logger: silentLogger(),
    fetch: fakeFetch({ "GET /api/v1/config": () => json({ instance: {} }) }),
  });
  assert.equal(await conn.checkOnline(), true);
  assert.equal(conn.isOnline(), true);
});

test("checkOnline: false on network error", async () => {
  const conn = new PeertubeConnection({
    config: baseConfig(),
    logger: silentLogger(),
    fetch: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(await conn.checkOnline(), false);
});

test("checkOnline: false when instance_url is empty", async () => {
  const cfg = baseConfig();
  cfg.peertube.instance_url = "";
  const conn = new PeertubeConnection({ config: cfg, logger: silentLogger() });
  assert.equal(await conn.checkOnline(), false);
});

// ── Auth ────────────────────────────────────────────────────────────

test("checkAuth: true and captures username on 200", async () => {
  const conn = new PeertubeConnection({
    config: baseConfig("tkn"),
    logger: silentLogger(),
    fetch: fakeFetch({
      "GET /api/v1/users/me": (_u, init) => {
        assert.equal((init.headers as Record<string, string>).Authorization, "Bearer tkn");
        return json({ username: "alice" });
      },
    }),
  });
  assert.equal(await conn.checkAuth(), true);
  assert.equal(conn.getUsername(), "alice");
  assert.equal(conn.isAuthenticated(), true);
});

test("checkAuth: false on 401", async () => {
  const conn = new PeertubeConnection({
    config: baseConfig("bad"),
    logger: silentLogger(),
    fetch: fakeFetch({ "GET /api/v1/users/me": () => new Response("", { status: 401 }) }),
  });
  assert.equal(await conn.checkAuth(), false);
  assert.equal(conn.getUsername(), null);
});

test("checkAuth: false when no token", async () => {
  const conn = new PeertubeConnection({
    config: baseConfig(""),
    logger: silentLogger(),
    fetch: fakeFetch({}),
  });
  assert.equal(await conn.checkAuth(), false);
});

// ── Token acquisition ───────────────────────────────────────────────

test("acquireToken: happy path writes token to config file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yt2pt-conn-"));
  const cfgPath = join(dir, "yt2pt.conf.toml");

  try {
    const cfg = baseConfig("");
    const conn = new PeertubeConnection({
      config: cfg,
      logger: silentLogger(),
      configPath: cfgPath,
      fetch: fakeFetch({
        "GET /api/v1/oauth-clients/local": () => json({ client_id: "cid", client_secret: "csec" }),
        "POST /api/v1/users/token": async (_u, init) => {
          const body = String(init.body);
          assert.ok(body.includes("grant_type=password"));
          assert.ok(body.includes("username=alice"));
          assert.ok(body.includes("client_id=cid"));
          return json({ access_token: "NEW_TOKEN", token_type: "Bearer" });
        },
        "GET /api/v1/users/me": () => json({ username: "alice" }),
      }),
    });

    const result = await conn.acquireToken("alice", "secret");
    assert.equal(result.success, true);
    assert.equal(cfg.peertube.api_token, "NEW_TOKEN");
    assert.equal(conn.isAuthenticated(), true);

    const written = readFileSync(cfgPath, "utf-8");
    assert.match(written, /api_token\s*=\s*"NEW_TOKEN"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireToken: returns error on bad credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yt2pt-conn-"));
  const cfgPath = join(dir, "yt2pt.conf.toml");
  try {
    const conn = new PeertubeConnection({
      config: baseConfig(""),
      logger: silentLogger(),
      configPath: cfgPath,
      fetch: fakeFetch({
        "GET /api/v1/oauth-clients/local": () => json({ client_id: "cid", client_secret: "csec" }),
        "POST /api/v1/users/token": () => new Response("invalid_grant", { status: 400 }),
      }),
    });
    const result = await conn.acquireToken("alice", "wrong");
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /400/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── authFetch ───────────────────────────────────────────────────────

test("authFetch: passes through 200", async () => {
  const conn = new PeertubeConnection({
    config: baseConfig("tkn"),
    logger: silentLogger(),
    fetch: fakeFetch({ "GET /api/v1/videos": () => json({ data: [] }) }),
  });
  const res = await conn.authFetch("/videos");
  assert.equal(res.status, 200);
});

test("authFetch: retries once on 401 if auth recovers; marks disconnected if still 401", async () => {
  let calls = 0;
  const conn = new PeertubeConnection({
    config: baseConfig("tkn"),
    logger: silentLogger(),
    fetch: fakeFetch({
      "GET /api/v1/videos": () => {
        calls++;
        return new Response("", { status: 401 });
      },
      "GET /api/v1/users/me": () => json({ username: "alice" }),
    }),
  });
  const res = await conn.authFetch("/videos");
  assert.equal(res.status, 401);
  assert.equal(calls, 2, "should retry exactly once after re-auth");
  assert.equal(conn.isAuthenticated(), false);
});

// ── refresh() ───────────────────────────────────────────────────────

test("refresh: aggregates online + auth state", async () => {
  const conn = new PeertubeConnection({
    config: baseConfig("tkn"),
    logger: silentLogger(),
    fetch: fakeFetch({
      "GET /api/v1/config": () => json({ instance: {} }),
      "GET /api/v1/users/me": () => json({ username: "alice" }),
    }),
  });
  const status = await conn.refresh();
  assert.equal(status.online, true);
  assert.equal(status.authenticated, true);
  assert.equal(status.username, "alice");
  assert.equal(status.instance_url, "https://peertube.example");
});
