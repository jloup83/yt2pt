/**
 * Thin fetch wrapper around the daemon API. In dev, Vite proxies /api to
 * the daemon on :8090. In production, the daemon serves this SPA itself,
 * so /api is same-origin.
 */

export interface ApiError extends Error {
  status: number;
  body?: unknown;
}

function toApiError(status: number, body: unknown): ApiError {
  const msg =
    (body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
      ? (body as { error: string }).error
      : null) ?? `HTTP ${status}`;
  const err = new Error(msg) as ApiError;
  err.status = status;
  err.body = body;
  return err;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`/api${path}`, { ...init, headers });
  const ct = res.headers.get("content-type") ?? "";
  const body = ct.includes("application/json") ? await res.json().catch(() => null) : null;
  if (!res.ok) throw toApiError(res.status, body);
  if (res.status === 204) return undefined as T;
  return body as T;
}

export const api = {
  get: <T = unknown>(path: string): Promise<T> => request<T>(path),
  post: <T = unknown>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined }),
  put: <T = unknown>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: "PUT", body: body !== undefined ? JSON.stringify(body) : undefined }),
  delete: <T = unknown>(path: string): Promise<T> => request<T>(path, { method: "DELETE" }),
};

// ── Typed endpoint helpers ──────────────────────────────────────────

export interface HealthResponse { status: string; version: string }
export interface PeertubeStatus {
  online: boolean;
  authenticated: boolean;
  instance_url: string;
  username: string | null;
}
export interface ChannelSummary {
  id: number;
  youtube_channel_url: string;
  youtube_channel_name: string | null;
  peertube_channel_id: string;
  added_at: string;
  last_synced_at: string | null;
  video_count: number;
  status_summary: Record<string, number>;
}
export interface VideoRow {
  id: number;
  youtube_video_id: string;
  channel_id: number;
  channel_name: string | null;
  title: string | null;
  status: string;
  progress_pct: number;
  error_message: string | null;
  folder_name: string | null;
  created_at: string;
  updated_at: string;
}
export interface VideoListResponse {
  videos: VideoRow[];
  total: number;
  page: number;
  per_page: number;
}

export const endpoints = {
  health: () => api.get<HealthResponse>("/health"),
  peertubeStatus: () => api.get<PeertubeStatus>("/peertube/status"),
  listChannels: () => api.get<{ channels: ChannelSummary[] }>("/channels"),
  listVideos: (params: URLSearchParams = new URLSearchParams()): Promise<VideoListResponse> => {
    const qs = params.toString();
    return api.get<VideoListResponse>(`/videos${qs ? `?${qs}` : ""}`);
  },
};
