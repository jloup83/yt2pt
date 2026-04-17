import { paint, padRight, statusPresentation, truncate, colorsEnabled } from "./format";
import { relativeTime } from "./time";

export interface VideoRow {
  id: number;
  status: string;
  channel_name: string | null;
  title: string | null;
  updated_at: string;
  progress_pct?: number;
}

interface Column {
  header: string;
  width: number;
  render: (row: VideoRow, now: Date) => { plain: string; colored: string };
}

/**
 * Render a formatted table of videos. On a TTY with colors enabled,
 * status cells get a unicode glyph and color; off-TTY the output is
 * plain ASCII with the same column widths so pipes still line up.
 */
export function renderVideosTable(rows: VideoRow[], now: Date = new Date()): string {
  const columns = buildColumns(rows, now);
  const lines: string[] = [];

  // Header row
  lines.push(columns.map((c) => padRight(c.header, c.width)).join("  "));
  // Separator
  lines.push(columns.map((c) => "─".repeat(c.width)).join("  "));
  // Data rows
  for (const row of rows) {
    const cells = columns.map((col) => {
      const { plain, colored } = col.render(row, now);
      const padded = padRight(plain, col.width);
      if (plain === colored) return padded;
      // keep width based on plain text, then substitute colored variant for the content portion
      return colored + padded.slice(plain.length);
    });
    lines.push(cells.join("  "));
  }
  return lines.join("\n");
}

function buildColumns(rows: VideoRow[], now: Date): Column[] {
  const idWidth = Math.max(2, ...rows.map((r) => String(r.id).length));
  const channelWidth = clamp(
    Math.max(7, ...rows.map((r) => (r.channel_name ?? "—").length)),
    7,
    20,
  );
  const statusWidth = Math.max(
    "Status".length,
    ...rows.map((r) => renderStatusPlain(r).length),
  );
  const timeWidth = Math.max(
    "Updated".length,
    ...rows.map((r) => relativeTime(r.updated_at, now).length),
  );

  return [
    {
      header: "ID",
      width: idWidth,
      render: (row) => {
        const s = String(row.id);
        return { plain: s, colored: s };
      },
    },
    {
      header: "Status",
      width: statusWidth,
      render: (row) => ({ plain: renderStatusPlain(row), colored: renderStatusColored(row) }),
    },
    {
      header: "Channel",
      width: channelWidth,
      render: (row) => {
        const raw = row.channel_name ?? "—";
        const s = truncate(raw, channelWidth);
        return { plain: s, colored: s };
      },
    },
    {
      header: "Title",
      width: 40,
      render: (row) => {
        const raw = row.title ?? "(no title)";
        const s = truncate(raw, 40);
        return { plain: s, colored: s };
      },
    },
    {
      header: "Updated",
      width: timeWidth,
      render: (row, n) => {
        const s = relativeTime(row.updated_at, n);
        return { plain: s, colored: colorsEnabled() ? paint(s, "gray") : s };
      },
    },
  ];
}

function renderStatusPlain(row: VideoRow): string {
  const pres = statusPresentation(row.status);
  const symbol = colorsEnabled() ? `${pres.symbol} ` : "";
  const pct = row.status === "UPLOADING" && typeof row.progress_pct === "number" && row.progress_pct > 0
    ? ` ${row.progress_pct}%`
    : "";
  return `${symbol}${pres.label}${pct}`;
}

function renderStatusColored(row: VideoRow): string {
  const pres = statusPresentation(row.status);
  const symbol = colorsEnabled() ? `${pres.symbol} ` : "";
  const pct = row.status === "UPLOADING" && typeof row.progress_pct === "number" && row.progress_pct > 0
    ? ` ${row.progress_pct}%`
    : "";
  return paint(`${symbol}${pres.label}${pct}`, pres.color);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
