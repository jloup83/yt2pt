// ── Color & TTY helpers ─────────────────────────────────────────────
//
// The CLI tries to be pleasant on a TTY and boring-but-parseable off of
// it. We detect TTY via `process.stdout.isTTY` and honor NO_COLOR.

export type Stream = "stdout" | "stderr";

export function isTty(stream: Stream = "stdout"): boolean {
  const s = stream === "stdout" ? process.stdout : process.stderr;
  return Boolean(s.isTTY);
}

export function colorsEnabled(stream: Stream = "stdout"): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.YT2PT_NO_COLOR !== undefined && process.env.YT2PT_NO_COLOR !== "") return false;
  return isTty(stream);
}

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
} as const;

type Color = keyof typeof C;

export function paint(text: string, color: Color, stream: Stream = "stdout"): string {
  if (!colorsEnabled(stream)) return text;
  return `${C[color]}${text}${C.reset}`;
}

// ── JSON output ─────────────────────────────────────────────────────

/**
 * Global `--json` switch. Parsed once by `index.ts` before any command
 * dispatches so helpers don't need to thread it through every call.
 */
let jsonMode = false;

export function setJsonMode(on: boolean): void {
  jsonMode = on;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

// ── Status vocabulary ───────────────────────────────────────────────

export interface StatusPresentation {
  color: Color;
  symbol: string;
  label: string;
}

const STATUS_TABLE: Record<string, StatusPresentation> = {
  DOWNLOAD_QUEUED: { color: "gray",    symbol: "·", label: "DOWNLOAD_QUEUED" },
  DOWNLOADING:     { color: "cyan",    symbol: "↓", label: "DOWNLOADING" },
  DOWNLOAD_FAILED: { color: "red",     symbol: "✗", label: "DOWNLOAD_FAIL" },
  CONVERT_QUEUED:  { color: "gray",    symbol: "·", label: "CONVERT_QUEUED" },
  CONVERTING:      { color: "yellow",  symbol: "⟳", label: "CONVERTING" },
  CONVERT_FAILED:  { color: "red",     symbol: "✗", label: "CONVERT_FAIL" },
  UPLOAD_QUEUED:   { color: "gray",    symbol: "·", label: "UPLOAD_QUEUED" },
  UPLOADING:       { color: "blue",    symbol: "↑", label: "UPLOADING" },
  UPLOAD_FAILED:   { color: "red",     symbol: "✗", label: "UPLOAD_FAIL" },
  UPLOADED:        { color: "green",   symbol: "✓", label: "UPLOADED" },
};

export function statusPresentation(status: string): StatusPresentation {
  return STATUS_TABLE[status] ?? { color: "gray", symbol: "?", label: status };
}

// ── Misc ────────────────────────────────────────────────────────────

/** Display-width-aware truncation (ASCII assumption; good enough for YouTube titles). */
export function truncate(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return `${text.slice(0, width - 1)}…`;
}

export function padRight(text: string, width: number): string {
  if (text.length >= width) return text;
  return text + " ".repeat(width - text.length);
}
