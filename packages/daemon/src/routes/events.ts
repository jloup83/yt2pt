import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ServerContext } from "../server";
import type { Video } from "../db/videos";
import type { ConnectionStatus } from "../peertube/connection";

/**
 * Payload format for `video_status` events. A subset of the full Video
 * row — just what the UI needs to patch its cached state.
 */
export interface VideoStatusEvent {
  id: number;
  status: string;
  progress_pct: number;
  updated_at: string;
  error_message: string | null;
}

export function videoToStatusEvent(v: Video): VideoStatusEvent {
  return {
    id: v.id,
    status: v.status,
    progress_pct: v.progress_pct,
    updated_at: v.updated_at,
    error_message: v.error_message,
  };
}

/** Serialize any JSON-able value to a single SSE frame. */
export function formatSseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const PEERTUBE_POLL_MS = 5_000;

export async function registerEventsRoutes(app: FastifyInstance): Promise<void> {
  const ctx: ServerContext = app.ctx;

  app.get("/api/events", async (req: FastifyRequest, reply: FastifyReply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // Retry hint + initial hello so clients know the stream is live.
    reply.raw.write(`retry: 5000\n\n`);
    reply.raw.write(formatSseFrame("hello", { ts: new Date().toISOString() }));

    const send = (event: string, data: unknown): void => {
      try {
        reply.raw.write(formatSseFrame(event, data));
      } catch {
        // Connection likely closed; cleanup handler will tear down.
      }
    };

    // ── Queue events → video_status / sync_complete ────────────────
    const onStatus = (video: Video): void => send("video_status", videoToStatusEvent(video));
    const onProgress = (video: Video): void => send("video_status", videoToStatusEvent(video));
    const queueEvents = ctx.queue?.events;
    queueEvents?.on("status-change", onStatus);
    queueEvents?.on("progress", onProgress);

    // ── Sync engine events ─────────────────────────────────────────
    const onSyncStarted = (p: unknown): void => send("sync_started", p);
    const onSyncProgress = (p: unknown): void => send("sync_progress", p);
    const onSyncCompleted = (p: unknown): void => send("sync_complete", p);
    const onSyncFailed = (p: unknown): void => send("sync_failed", p);
    const sync = ctx.sync;
    sync?.on("sync-started", onSyncStarted);
    sync?.on("sync-progress", onSyncProgress);
    sync?.on("sync-completed", onSyncCompleted);
    sync?.on("sync-failed", onSyncFailed);

    // ── PeerTube status poll → peertube_status on change ───────────
    let lastStatus: ConnectionStatus | null = ctx.peertube?.getStatus() ?? null;
    if (lastStatus) send("peertube_status", lastStatus);
    const poll = ctx.peertube
      ? setInterval(() => {
          const current = ctx.peertube!.getStatus();
          if (
            !lastStatus ||
            current.online !== lastStatus.online ||
            current.authenticated !== lastStatus.authenticated ||
            current.username !== lastStatus.username ||
            current.instance_url !== lastStatus.instance_url
          ) {
            lastStatus = current;
            send("peertube_status", current);
          }
        }, PEERTUBE_POLL_MS)
      : null;
    poll?.unref?.();

    // ── Heartbeat so proxies don't reap idle connections ───────────
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: ping ${Date.now()}\n\n`);
      } catch {
        // noop; close handler cleans up.
      }
    }, 15_000);
    heartbeat.unref?.();

    // ── Cleanup on client disconnect ───────────────────────────────
    const cleanup = (): void => {
      queueEvents?.off("status-change", onStatus);
      queueEvents?.off("progress", onProgress);
      sync?.off("sync-started", onSyncStarted);
      sync?.off("sync-progress", onSyncProgress);
      sync?.off("sync-completed", onSyncCompleted);
      sync?.off("sync-failed", onSyncFailed);
      if (poll) clearInterval(poll);
      clearInterval(heartbeat);
    };
    req.raw.on("close", cleanup);
    req.raw.on("error", cleanup);

    // Keep Fastify's response handling from auto-closing the stream.
    return reply;
  });
}
