import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiClient, ApiError, DaemonUnreachableError, resolveDaemonUrl } from "./client";

test("resolveDaemonUrl prefers explicit flag value", () => {
  assert.equal(
    resolveDaemonUrl("http://flag:1/", { YT2PT_DAEMON_URL: "http://env:2" }),
    "http://flag:1",
  );
});

test("resolveDaemonUrl falls back to env var", () => {
  assert.equal(resolveDaemonUrl(undefined, { YT2PT_DAEMON_URL: "http://env:2" }), "http://env:2");
});

test("resolveDaemonUrl uses default when no flag or env", () => {
  assert.equal(resolveDaemonUrl(undefined, {}), "http://localhost:8090");
});

test("resolveDaemonUrl strips trailing slashes", () => {
  assert.equal(resolveDaemonUrl("http://host:1234///"), "http://host:1234");
});

test("ApiClient.url assembles base + path + query", () => {
  const c = new ApiClient({ baseUrl: "http://x:1", fetch: fakeFetch({}) });
  assert.equal(c.url("/api/videos"), "http://x:1/api/videos");
  assert.equal(
    c.url("/api/videos", { status: "UPLOADING", page: 2, skip: undefined }),
    "http://x:1/api/videos?status=UPLOADING&page=2",
  );
});

test("ApiClient.request returns parsed JSON on success", async () => {
  const c = new ApiClient({ baseUrl: "http://x:1", fetch: fakeFetch({ body: '{"ok":true}' }) });
  const got = await c.request<{ ok: boolean }>("/api/health");
  assert.deepEqual(got, { ok: true });
});

test("ApiClient.request throws ApiError on non-2xx with JSON body", async () => {
  const c = new ApiClient({
    baseUrl: "http://x:1",
    fetch: fakeFetch({ status: 400, body: '{"error":"bad"}' }),
  });
  await assert.rejects(() => c.request("/api/x"), (err: unknown) => {
    return err instanceof ApiError && err.status === 400 && err.message === "bad";
  });
});

test("ApiClient.request throws DaemonUnreachableError on network failure", async () => {
  const c = new ApiClient({
    baseUrl: "http://x:1",
    fetch: (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch,
  });
  await assert.rejects(() => c.request("/api/x"), (err: unknown) => err instanceof DaemonUnreachableError);
});

test("ApiClient.request returns null on 204", async () => {
  const c = new ApiClient({
    baseUrl: "http://x:1",
    fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch,
  });
  const got = await c.request("/api/channels/1");
  assert.equal(got, null);
});

// ── Helpers ─────────────────────────────────────────────────────────

interface FakeFetchOpts {
  status?: number;
  body?: string;
}

function fakeFetch(opts: FakeFetchOpts): typeof fetch {
  const status = opts.status ?? 200;
  const body = opts.body ?? "{}";
  return (async (_url: unknown, _init: unknown) => {
    return new Response(body, { status });
  }) as unknown as typeof fetch;
}
