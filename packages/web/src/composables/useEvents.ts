/**
 * Shared SSE client for the daemon's `/api/events` stream.
 *
 * Singleton — every call to `useEvents()` returns the same underlying
 * EventSource connection. State + callbacks are shared across the whole
 * SPA; the first caller opens the connection, and it's closed only when
 * the last component that called `useEvents()` unmounts.
 *
 * Exposed API per call:
 *   const { connected, peertubeStatus, onVideoUpdate, onSyncComplete,
 *           onSyncStarted, onSyncProgress, onSyncFailed } = useEvents();
 *
 * Registered callbacks are automatically removed when the calling
 * component's scope disposes (i.e. on unmount) — no manual cleanup.
 */
import { onScopeDispose, ref, type Ref } from "vue";
import type { PeertubeStatus, VideoRow } from "../api";

export type VideoStatusEvent = Pick<
  VideoRow,
  "id" | "status" | "progress_pct" | "updated_at" | "error_message"
>;
export interface SyncStartedEvent { channel_id: number }
export interface SyncProgressEvent { channel_id: number; processed: number; total: number }
export interface SyncCompleteEvent {
  channel_id: number;
  new_videos: number;
  already_tracked: number;
}
export interface SyncFailedEvent { channel_id: number; error: string }

type Listener<T> = (payload: T) => void;
type Unsubscribe = () => void;

// ── Module-level shared state ─────────────────────────────────────
const connectedRef = ref(false);
const peertubeStatusRef = ref<PeertubeStatus | null>(null);

const videoListeners = new Set<Listener<VideoStatusEvent>>();
const syncStartedListeners = new Set<Listener<SyncStartedEvent>>();
const syncProgressListeners = new Set<Listener<SyncProgressEvent>>();
const syncCompleteListeners = new Set<Listener<SyncCompleteEvent>>();
const syncFailedListeners = new Set<Listener<SyncFailedEvent>>();

let es: EventSource | null = null;
let refCount = 0;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function dispatch<T>(set: Set<Listener<T>>, payload: T): void {
  for (const fn of set) {
    try { fn(payload); } catch { /* ignore listener errors */ }
  }
}

function clearReconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(): void {
  clearReconnect();
  // 1s, 2s, 4s, 8s, 16s, 30s (cap).
  const delay = Math.min(30_000, 1000 * 2 ** reconnectAttempts);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (refCount > 0 && !es) openConnection();
  }, delay);
}

function openConnection(): void {
  if (es) return;
  let source: EventSource;
  try {
    source = new EventSource("/api/events");
  } catch {
    scheduleReconnect();
    return;
  }
  es = source;

  source.addEventListener("open", () => {
    connectedRef.value = true;
    reconnectAttempts = 0;
  });

  source.addEventListener("error", () => {
    connectedRef.value = false;
    // Browser auto-reconnects for transient network errors, but close
    // the stream ourselves on terminal errors (e.g. server restart) and
    // schedule an explicit backoff so we don't hammer the daemon.
    if (source.readyState === EventSource.CLOSED) {
      try { source.close(); } catch { /* noop */ }
      if (es === source) es = null;
      if (refCount > 0) scheduleReconnect();
    }
  });

  const parse = <T>(ev: Event): T | null => {
    try { return JSON.parse((ev as MessageEvent).data) as T; } catch { return null; }
  };

  source.addEventListener("hello", () => {
    connectedRef.value = true;
    reconnectAttempts = 0;
  });
  source.addEventListener("peertube_status", (ev) => {
    const data = parse<PeertubeStatus>(ev);
    if (data) peertubeStatusRef.value = data;
  });
  source.addEventListener("video_status", (ev) => {
    const data = parse<VideoStatusEvent>(ev);
    if (data && typeof data.id === "number") dispatch(videoListeners, data);
  });
  source.addEventListener("sync_started", (ev) => {
    const data = parse<SyncStartedEvent>(ev);
    if (data) dispatch(syncStartedListeners, data);
  });
  source.addEventListener("sync_progress", (ev) => {
    const data = parse<SyncProgressEvent>(ev);
    if (data) dispatch(syncProgressListeners, data);
  });
  source.addEventListener("sync_complete", (ev) => {
    const data = parse<SyncCompleteEvent>(ev);
    if (data) dispatch(syncCompleteListeners, data);
  });
  source.addEventListener("sync_failed", (ev) => {
    const data = parse<SyncFailedEvent>(ev);
    if (data) dispatch(syncFailedListeners, data);
  });
}

function closeConnection(): void {
  clearReconnect();
  reconnectAttempts = 0;
  if (es) {
    try { es.close(); } catch { /* noop */ }
    es = null;
  }
  connectedRef.value = false;
}

function on<T>(set: Set<Listener<T>>, fn: Listener<T>): Unsubscribe {
  set.add(fn);
  const unsub = (): void => { set.delete(fn); };
  onScopeDispose(unsub);
  return unsub;
}

// ── Public composable ────────────────────────────────────────────
export interface UseEventsReturn {
  connected: Ref<boolean>;
  peertubeStatus: Ref<PeertubeStatus | null>;
  onVideoUpdate: (fn: Listener<VideoStatusEvent>) => Unsubscribe;
  onSyncStarted: (fn: Listener<SyncStartedEvent>) => Unsubscribe;
  onSyncProgress: (fn: Listener<SyncProgressEvent>) => Unsubscribe;
  onSyncComplete: (fn: Listener<SyncCompleteEvent>) => Unsubscribe;
  onSyncFailed: (fn: Listener<SyncFailedEvent>) => Unsubscribe;
  /** Force-close the shared stream. Rarely needed; ref-counting handles lifetime. */
  close: () => void;
}

export function useEvents(): UseEventsReturn {
  refCount += 1;
  if (!es && refCount === 1) openConnection();

  onScopeDispose(() => {
    refCount -= 1;
    if (refCount <= 0) {
      refCount = 0;
      closeConnection();
    }
  });

  return {
    connected: connectedRef,
    peertubeStatus: peertubeStatusRef,
    onVideoUpdate:   (fn) => on(videoListeners, fn),
    onSyncStarted:   (fn) => on(syncStartedListeners, fn),
    onSyncProgress:  (fn) => on(syncProgressListeners, fn),
    onSyncComplete:  (fn) => on(syncCompleteListeners, fn),
    onSyncFailed:    (fn) => on(syncFailedListeners, fn),
    close: closeConnection,
  };
}
