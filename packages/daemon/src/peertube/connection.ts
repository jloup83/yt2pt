import { saveConfig, type Config, type Logger } from "@yt2pt/shared";

export interface ConnectionStatus {
  online: boolean;
  authenticated: boolean;
  instance_url: string;
  username: string | null;
}

export interface AcquireTokenResult {
  success: boolean;
  error?: string;
}

type FetchFn = typeof fetch;

export interface PeertubeConnectionOptions {
  config: Config;
  logger: Logger;
  /** Poll interval for background online/auth checks (ms). Default 30s. */
  pollIntervalMs?: number;
  /** Path to write config to when a token is acquired. */
  configPath?: string;
  /** Override for testing. */
  fetch?: FetchFn;
}

const DEFAULT_POLL_MS = 30_000;

export class PeertubeConnection {
  private online = false;
  private authenticated = false;
  private username: string | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private rawFetch: FetchFn;
  private fetch: FetchFn;

  constructor(private opts: PeertubeConnectionOptions) {
    this.rawFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.fetch = this.loggingFetch.bind(this);
  }

  /**
   * Thin wrapper around the underlying fetch that emits a debug line
   * for every PeerTube API call: method, URL, body kind+size (with
   * Authorization redacted) before the call, and status+duration after.
   */
  private async loggingFetch(input: Parameters<FetchFn>[0], init: RequestInit = {}): Promise<Response> {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init.method ?? "GET").toUpperCase();
    const bodyDesc = describeBody(init.body);
    const t0 = Date.now();
    this.opts.logger.debug(`→ ${method} ${url}${bodyDesc ? ` body=${bodyDesc}` : ""}`);
    try {
      const res = await this.rawFetch(input, init);
      this.opts.logger.debug(`← ${method} ${url} ${res.status} (${Date.now() - t0}ms)`);
      return res;
    } catch (err) {
      this.opts.logger.debug(`✗ ${method} ${url} failed after ${Date.now() - t0}ms: ${errMsg(err)}`);
      throw err;
    }
  }

  // ── Accessors ────────────────────────────────────────────────────

  isOnline(): boolean { return this.online; }
  isAuthenticated(): boolean { return this.authenticated; }
  getUsername(): string | null { return this.username; }
  getToken(): string { return this.opts.config.peertube.api_token; }

  getStatus(): ConnectionStatus {
    return {
      online: this.online,
      authenticated: this.authenticated,
      instance_url: this.opts.config.peertube.instance_url,
      username: this.username,
    };
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.refresh();
    const interval = this.opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.pollTimer = setInterval(() => {
      void this.refresh();
    }, interval);
    // Don't keep the Node event loop alive just for polling.
    this.pollTimer.unref?.();
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Re-check online + auth in a single pass. */
  async refresh(): Promise<ConnectionStatus> {
    await this.checkOnline();
    if (this.online && this.getToken()) {
      await this.checkAuth();
    } else {
      this.setAuth(false, null);
    }
    return this.getStatus();
  }

  // ── Online check (no auth required) ──────────────────────────────

  async checkOnline(): Promise<boolean> {
    const url = this.apiUrl("/config");
    if (!this.opts.config.peertube.instance_url) {
      this.setOnline(false);
      return false;
    }
    try {
      const res = await this.fetch(url, { method: "GET" });
      this.setOnline(res.ok);
    } catch (err) {
      this.opts.logger.debug(`peertube online check failed: ${errMsg(err)}`);
      this.setOnline(false);
    }
    return this.online;
  }

  // ── Auth check ───────────────────────────────────────────────────

  async checkAuth(): Promise<boolean> {
    const token = this.getToken();
    if (!token) {
      this.setAuth(false, null);
      return false;
    }
    try {
      const res = await this.fetch(this.apiUrl("/users/me"), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        this.setAuth(false, null);
        return false;
      }
      if (!res.ok) {
        this.opts.logger.debug(`peertube auth check returned ${res.status}`);
        this.setAuth(false, null);
        return false;
      }
      const body = (await res.json()) as { username?: string };
      this.setAuth(true, body.username ?? null);
      return true;
    } catch (err) {
      this.opts.logger.debug(`peertube auth check failed: ${errMsg(err)}`);
      this.setAuth(false, null);
      return false;
    }
  }

  // ── State transitions (log once on change) ───────────────────────

  private setOnline(next: boolean): void {
    if (this.online === next) return;
    this.online = next;
    const url = this.opts.config.peertube.instance_url || "(unset)";
    if (next) {
      this.opts.logger.info(`PeerTube online: ${url}`);
    } else {
      this.opts.logger.warn(`PeerTube offline: ${url}`);
    }
  }

  private setAuth(next: boolean, username: string | null): void {
    if (this.authenticated === next && this.username === username) return;
    const wasAuthed = this.authenticated;
    this.authenticated = next;
    this.username = username;
    if (next) {
      this.opts.logger.info(`PeerTube authenticated as '${username ?? "?"}'`);
    } else if (wasAuthed) {
      this.opts.logger.warn(`PeerTube authentication lost`);
    }
  }

  // ── Token acquisition (OAuth password grant) ─────────────────────

  async acquireToken(username: string, password: string): Promise<AcquireTokenResult> {
    const logger = this.opts.logger;
    const url = this.opts.config.peertube.instance_url || "(unset)";
    logger.debug(`acquireToken: fetching oauth-clients/local from ${url}`);
    try {
      const clientRes = await this.fetch(this.apiUrl("/oauth-clients/local"));
      if (!clientRes.ok) {
        logger.warn(`acquireToken: oauth-clients/local returned ${clientRes.status}`);
        return { success: false, error: `oauth-clients/local returned ${clientRes.status}` };
      }
      const client = (await clientRes.json()) as { client_id: string; client_secret: string };

      const form = new URLSearchParams();
      form.set("client_id", client.client_id);
      form.set("client_secret", client.client_secret);
      form.set("grant_type", "password");
      form.set("username", username);
      form.set("password", password);

      logger.debug(`acquireToken: POST /users/token for '${username}'`);
      const tokenRes = await this.fetch(this.apiUrl("/users/token"), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });

      if (!tokenRes.ok) {
        const body = await tokenRes.text().catch(() => "");
        logger.warn(`acquireToken: users/token returned ${tokenRes.status}: ${body}`);
        return { success: false, error: `users/token returned ${tokenRes.status}: ${body}` };
      }
      const tokenBody = (await tokenRes.json()) as { access_token?: string };
      if (!tokenBody.access_token) {
        logger.error(`acquireToken: users/token response missing access_token`);
        return { success: false, error: "users/token response missing access_token" };
      }

      this.opts.config.peertube.api_token = tokenBody.access_token;
      try {
        saveConfig(this.opts.config, this.opts.configPath);
        logger.debug(`acquireToken: token persisted to ${this.opts.configPath ?? "(no path)"}`);
      } catch (err) {
        logger.error(`acquireToken: failed to persist token: ${errMsg(err)}`);
        return { success: false, error: `failed to persist token: ${errMsg(err)}` };
      }

      await this.checkAuth();
      return { success: true };
    } catch (err) {
      logger.error(`acquireToken: request failed: ${errMsg(err)}`);
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Authenticated fetch with one 401 retry. If the retry also returns 401
   * the connection is marked unauthenticated and the 401 response is
   * returned to the caller.
   */
  async authFetch(pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : this.apiUrl(pathOrUrl);
    const doFetch = (): Promise<Response> =>
      this.fetch(url, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          Authorization: `Bearer ${this.getToken()}`,
        },
      });
    let res = await doFetch();
    if (res.status !== 401) return res;

    // 401 — re-check auth status, then retry once.
    await this.checkAuth();
    if (!this.authenticated) return res;
    res = await doFetch();
    if (res.status === 401) {
      this.authenticated = false;
      this.username = null;
    }
    return res;
  }

  // ── Internal ─────────────────────────────────────────────────────

  private apiUrl(path: string): string {
    const base = this.opts.config.peertube.instance_url.replace(/\/+$/, "");
    const suffix = path.startsWith("/") ? path : `/${path}`;
    return `${base}/api/v1${suffix}`;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Short, redacted description of a fetch body for debug logs. Never
 * emits raw token/password values: form fields `password` and
 * `client_secret` are masked; JSON bodies with an `api_token` field
 * would not normally flow here (we don't POST tokens back to PT).
 */
function describeBody(body: RequestInit["body"] | null | undefined): string {
  if (body == null) return "";
  if (typeof body === "string") {
    // form-urlencoded (string) — redact sensitive fields.
    if (body.includes("=") && body.includes("&") === false && body.length < 2) return `str(${body.length})`;
    try {
      const params = new URLSearchParams(body);
      const parts: string[] = [];
      for (const [k, v] of params.entries()) {
        const redacted = k === "password" || k === "client_secret" || k === "access_token";
        parts.push(`${k}=${redacted ? "***" : truncate(v, 60)}`);
      }
      return `form{${parts.join(", ")}}`;
    } catch {
      return `str(${body.length})`;
    }
  }
  if (body instanceof URLSearchParams) {
    const parts: string[] = [];
    for (const [k, v] of body.entries()) {
      const redacted = k === "password" || k === "client_secret" || k === "access_token";
      parts.push(`${k}=${redacted ? "***" : truncate(v, 60)}`);
    }
    return `form{${parts.join(", ")}}`;
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const keys: string[] = [];
    for (const [k] of body.entries()) keys.push(k);
    return `multipart{${keys.join(", ")}}`;
  }
  if (body instanceof ArrayBuffer) return `bytes(${body.byteLength})`;
  if (ArrayBuffer.isView(body)) return `bytes(${body.byteLength})`;
  return "body(?)";
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
