// ── API client ──────────────────────────────────────────────────────
//
// A thin wrapper around `fetch` that talks to the yt2ptd daemon. Keeps
// the commands free of URL-assembly and error-parsing boilerplate.

export const DEFAULT_DAEMON_URL = "http://localhost:8090";

/**
 * Error raised when the daemon returns a non-2xx status. Carries the
 * HTTP status code and any JSON body the daemon sent so commands can
 * decide how to present it.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Error raised when the daemon is unreachable (connection refused,
 * DNS failure, etc.). Distinct from `ApiError` so the CLI can print a
 * friendly "is yt2ptd running?" hint.
 */
export class DaemonUnreachableError extends Error {
  readonly cause: unknown;
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(`Could not reach yt2ptd at ${url}`);
    this.name = "DaemonUnreachableError";
    this.url = url;
    this.cause = cause;
  }
}

// ── URL resolution ──────────────────────────────────────────────────

/**
 * Pick the daemon base URL. Priority:
 *   1. `--daemon-url=...` CLI flag (passed explicitly)
 *   2. `YT2PT_DAEMON_URL` env var
 *   3. `http://localhost:8090`
 */
export function resolveDaemonUrl(flagValue?: string, env: NodeJS.ProcessEnv = process.env): string {
  const raw = flagValue ?? env.YT2PT_DAEMON_URL ?? DEFAULT_DAEMON_URL;
  return raw.replace(/\/+$/, "");
}

// ── Client ──────────────────────────────────────────────────────────

export interface ClientOptions {
  baseUrl: string;
  /** Override fetch for tests. */
  fetch?: typeof fetch;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** AbortSignal so SSE / long-running requests can be cancelled. */
  signal?: AbortSignal;
  /** If true, don't try to JSON-decode the response (used for SSE). */
  raw?: boolean;
}

export class ApiClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** Build a full URL including query string. */
  url(path: string, query?: Record<string, string | number | undefined>): string {
    const u = new URL(`${this.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined) continue;
        u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  }

  async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    const url = this.url(path, opts.query);
    const init: RequestInit = {
      method: opts.method ?? "GET",
      headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    };

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (err) {
      throw new DaemonUnreachableError(this.baseUrl, err);
    }

    if (opts.raw) {
      if (!response.ok) {
        const body = await safeBody(response);
        throw new ApiError(`${response.status} ${response.statusText}`, response.status, body);
      }
      return response as unknown as T;
    }

    // 204 No Content or empty bodies — return null so callers don't choke on JSON.parse.
    if (response.status === 204) return null as T;

    const body = await safeBody(response);
    if (!response.ok) {
      const msg = extractError(body) ?? `${response.status} ${response.statusText}`;
      throw new ApiError(msg, response.status, body);
    }
    return body as T;
  }
}

async function safeBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractError(body: unknown): string | null {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error: unknown }).error;
    if (typeof err === "string") return err;
  }
  return null;
}
