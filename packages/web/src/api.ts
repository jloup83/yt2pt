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

export interface StorageInfo {
  disk_total_bytes: number;
  disk_free_bytes: number;
  data_dir_bytes: number;
}
export interface HealthResponse { status: string; version: string; storage: StorageInfo }
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
  avatar_url: string | null;
  banner_url: string | null;
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
  upload_date: string | null;
  created_at: string;
  updated_at: string;
}
export interface VideoListResponse {
  videos: VideoRow[];
  total: number;
  page: number;
  per_page: number;
}

// ── Settings ────────────────────────────────────────────────────────

export interface Yt2ptSection {
  data_dir: string;
  log_dir: string;
  log_level: string;
  overwrite_existing: boolean;
  skip_downloaded: boolean;
  remove_video_after_upload: boolean;
  remove_video_after_metadata_conversion: boolean;
}
export interface HttpSection { port: number; bind: string }
export interface WorkersSection {
  download_concurrency: number;
  convert_concurrency: number;
  upload_concurrency: number;
}
export interface YtdlpSection {
  format: string;
  merge_output_format: string;
  thumbnail_format: string;
  rate_limit_enabled: boolean;
  rate_limit: string;
}
export interface PeertubeSection {
  instance_url: string;
  api_token: string;
  channel_id: string;
  privacy: string;
  language: string;
  licence: string;
  comments_policy: string;
  wait_transcoding: boolean;
  generate_transcription: boolean;
}
export interface Settings {
  yt2pt: Yt2ptSection;
  http: HttpSection;
  workers: WorkersSection;
  ytdlp: YtdlpSection;
  peertube: PeertubeSection;
}
export type SettingsPatch = {
  [K in keyof Settings]?: Partial<Settings[K]>;
};
export interface TokenResponse { success: boolean; token?: string; error?: string }

// ── PeerTube channels (for the Add Channel dropdown) ──────────────
export interface PeertubeChannel { id: number; name: string; displayName: string }
export interface PeertubeChannelList { channels: PeertubeChannel[]; cached?: boolean }

export const endpoints = {
  health: () => api.get<HealthResponse>("/health"),
  peertubeStatus: () => api.get<PeertubeStatus>("/peertube/status"),
  peertubeChannels: (refresh = false) =>
    api.get<PeertubeChannelList>(`/peertube/channels${refresh ? "?refresh=1" : ""}`),
  listChannels: () => api.get<{ channels: ChannelSummary[] }>("/channels"),
  addChannel: (youtube_channel_url: string, peertube_channel_id: string) =>
    api.post<ChannelSummary>("/channels", { youtube_channel_url, peertube_channel_id }),
  addVideo: (youtube_url: string, peertube_channel_id: string) =>
    api.post<{ status: string; video_id: number; channel_id: number }>(
      "/videos", { youtube_url, peertube_channel_id },
    ),
  createPeertubeChannelFromYoutube: (
    youtube_url: string,
    overrides?: { name?: string; displayName?: string; description?: string; support?: string },
  ) =>
    api.post<{
      mapping: { id: number; youtube_channel_url: string; peertube_channel_id: string };
      peertube_channel?: { id: number; name: string; displayName: string };
      payload?: { name: string; displayName: string; description: string; support: string };
      warnings?: string[];
      already_mapped?: boolean;
      sync?: { status: "started" | "in_progress" | "rate_limited" | "unavailable" | "error"; retry_after_s?: number; error?: string };
    }>("/peertube/channels/create-from-youtube", { youtube_url, overrides }),
  previewPeertubeChannelFromYoutube: (
    youtube_url: string,
    overrides?: { name?: string; displayName?: string; description?: string; support?: string },
  ) =>
    api.post<{
      youtube_channel_url: string;
      payload: { name: string; displayName: string; description: string; support: string };
      has_avatar: boolean;
      has_banner: boolean;
      already_mapped: boolean;
      existing_peertube_channel_id: string | null;
    }>("/peertube/channels/preview-from-youtube", { youtube_url, overrides }),
  deleteChannel: (id: number, fromPeertube = false) =>
    api.delete<{
      status?: string;
      videos_deleted?: number;
      warnings?: string[];
    }>(`/channels/${id}${fromPeertube ? "?from_peertube=true" : ""}`),
  deleteVideo: (id: number, fromPeertube = false) =>
    api.delete<{
      status: string;
      id: number;
      cancelled: boolean;
      peertube_deleted: boolean | null;
      warnings: string[];
    }>(`/videos/${id}${fromPeertube ? "?from_peertube=true" : ""}`),
  syncChannel: (id: number) =>
    api.post<{ status: string; channel_id: number }>(`/channels/${id}/sync`),
  listVideos: (params: URLSearchParams = new URLSearchParams()): Promise<VideoListResponse> => {
    const qs = params.toString();
    return api.get<VideoListResponse>(`/videos${qs ? `?${qs}` : ""}`);
  },
  getSettings: () => api.get<Settings>("/settings"),
  updateSettings: (patch: SettingsPatch) => api.put<Settings>("/settings", patch),
  acquireToken: (username: string, password: string) =>
    api.post<TokenResponse>("/settings/token", { username, password }),
};
