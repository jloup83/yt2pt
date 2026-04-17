import { EventEmitter } from "node:events";
import type { Video } from "../db/videos";

export interface QueueEventMap {
  "status-change": [video: Video];
  progress: [video: Video];
}

/**
 * Typed event emitter for queue state changes. Consumers (SSE endpoint in #59)
 * subscribe via `.on('status-change', ...)` and `.on('progress', ...)`.
 */
export class QueueEvents extends EventEmitter<QueueEventMap> {}
