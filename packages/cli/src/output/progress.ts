import { isTty, paint, truncate } from "./format";

// ── Progress bar rendering ──────────────────────────────────────────

export function renderBar(done: number, total: number, width = 20): string {
  if (total <= 0) {
    return `[${" ".repeat(width)}]`;
  }
  const ratio = Math.max(0, Math.min(1, done / total));
  const filled = Math.round(width * ratio);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

// ── Sync progress display ───────────────────────────────────────────

export interface SyncSnapshot {
  channel_name: string;
  discovered: number;
  already_tracked: number;
  new_videos: number;
  downloading: { done: number; total: number; current?: string | null };
  converting: { done: number; total: number; current?: string | null };
  uploading:  { done: number; total: number; current?: string | null };
}

export function makeEmptySnapshot(channelName: string): SyncSnapshot {
  return {
    channel_name: channelName,
    discovered: 0,
    already_tracked: 0,
    new_videos: 0,
    downloading: { done: 0, total: 0, current: null },
    converting: { done: 0, total: 0, current: null },
    uploading:  { done: 0, total: 0, current: null },
  };
}

/**
 * TTY-aware progress renderer. On a TTY it rewrites the same block of
 * lines in place using ANSI cursor controls. On a plain stream it emits
 * one-line progress snapshots.
 */
export class SyncProgressRenderer {
  private linesWritten = 0;
  private readonly tty: boolean;
  private readonly out: NodeJS.WritableStream;

  constructor(out: NodeJS.WritableStream = process.stdout, tty = isTty("stdout")) {
    this.out = out;
    this.tty = tty;
  }

  /** Emit a plain status line that stays in the scrollback. */
  line(text: string): void {
    this.clear();
    this.out.write(`${text}\n`);
  }

  render(snap: SyncSnapshot): void {
    const body = formatSnapshot(snap, this.tty);
    if (!this.tty) {
      this.out.write(`${body}\n`);
      return;
    }
    this.clear();
    this.out.write(body);
    this.linesWritten = body.split("\n").length;
  }

  /** Wipe any in-place block so subsequent final messages aren't stacked on it. */
  clear(): void {
    if (!this.tty || this.linesWritten === 0) return;
    // Move up N lines and clear each one.
    this.out.write(`\x1b[${this.linesWritten}F`);
    this.out.write(`\x1b[0J`);
    this.linesWritten = 0;
  }
}

// ── Formatting ──────────────────────────────────────────────────────

export function formatSnapshot(snap: SyncSnapshot, withColor: boolean): string {
  const header = `Syncing channel "${snap.channel_name}"…`;
  const summary =
    snap.discovered > 0
      ? `Found ${snap.discovered} videos (${snap.new_videos} new, ${snap.already_tracked} already tracked)`
      : `Scanning channel…`;

  const phase = (label: string, p: { done: number; total: number; current?: string | null }): string => {
    const bar = renderBar(p.done, p.total);
    const count = `${p.done}/${p.total}`;
    const title = p.current ? truncate(p.current, 40) : "";
    const line = `${padLabel(label)}  ${bar} ${count}  ${title}`;
    return withColor ? paint(line, "cyan") : line;
  };

  return [
    header,
    summary,
    "",
    phase("Downloading:", snap.downloading),
    phase("Converting: ", snap.converting),
    phase("Uploading:  ", snap.uploading),
  ].join("\n");
}

function padLabel(label: string): string {
  return label.padEnd(12, " ");
}
