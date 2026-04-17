import { ApiClient, ApiError, DaemonUnreachableError } from "./client";

/**
 * One Server-Sent Events message as parsed from the raw stream.
 * `event` defaults to "message" when the server omits the event tag.
 */
export interface SseMessage {
  event: string;
  data: string;
}

/** Parse a JSON-encoded SSE payload; returns raw string on parse failure. */
export function parseSseData<T = unknown>(msg: SseMessage): T | string {
  try {
    return JSON.parse(msg.data) as T;
  } catch {
    return msg.data;
  }
}

/**
 * Open /api/events and yield SSE messages until the signal aborts or
 * the server closes the stream. Implemented over `fetch`'s ReadableStream
 * so we don't need a dedicated EventSource polyfill.
 */
export async function* openEventStream(
  client: ApiClient,
  signal?: AbortSignal,
): AsyncGenerator<SseMessage, void, void> {
  const res = await client.request<Response>("/api/events", { raw: true, signal });

  if (!res.body) {
    throw new ApiError("SSE response has no body", res.status, null);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });

      // SSE frames are terminated by a blank line ("\n\n").
      let sepIdx: number;
      while ((sepIdx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, sepIdx);
        buf = buf.slice(sepIdx + 2);
        const parsed = parseFrame(frame);
        if (parsed) yield parsed;
      }
    }
  } catch (err) {
    if ((err as Error | undefined)?.name === "AbortError") return;
    // Propagate unreachable errors verbatim so the CLI can print a hint.
    if (err instanceof DaemonUnreachableError) throw err;
    throw err;
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

/**
 * Parse a single SSE frame (a block of non-blank lines). Comment lines
 * starting with ":" are ignored. Returns null for frames that have no
 * data payload (e.g. `retry:` hints).
 */
export function parseFrame(frame: string): SseMessage | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
    // ignore id/retry — we don't need them for the CLI's short-lived streams
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}
