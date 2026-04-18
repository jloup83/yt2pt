import type { ApiClient } from "../api/client";
import { isJsonMode, paint, printJson } from "../output/format";

interface PeertubeStatus {
  online: boolean;
  authenticated: boolean;
  instance_url: string;
  username: string | null;
}

interface HealthResponse {
  status: string;
  version?: string;
  storage?: {
    disk_total_bytes: number;
    disk_free_bytes: number;
    data_dir_bytes: number;
  };
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export async function runStatus(client: ApiClient): Promise<number> {
  const health = await client.request<HealthResponse>("/api/health");
  const pt = await client.request<PeertubeStatus>("/api/peertube/status");

  if (isJsonMode()) {
    printJson({ daemon: { url: client.baseUrl, ...health }, peertube: pt });
    return 0;
  }

  const ok = (s: string): string => paint(s, "green");
  const bad = (s: string): string => paint(s, "red");
  const dim = (s: string): string => paint(s, "gray");

  const lines: string[] = [];
  lines.push(`Daemon:    ${ok("online")}  ${dim(client.baseUrl)}`);
  if (health.version) lines.push(`Version:   ${health.version}`);
  lines.push(`PeerTube:  ${pt.online ? ok("online") : bad("offline")}  ${dim(pt.instance_url)}`);
  lines.push(
    `Auth:      ${
      pt.authenticated
        ? `${ok("authenticated")} as ${pt.username ?? "?"}`
        : bad("not authenticated")
    }`,
  );

  if (health.storage) {
    const s = health.storage;
    const used = s.disk_total_bytes - s.disk_free_bytes;
    const pct = s.disk_total_bytes > 0 ? ((used / s.disk_total_bytes) * 100).toFixed(1) : "?";
    lines.push("");
    lines.push(`Disk:      ${fmtBytes(s.disk_total_bytes)} total, ${fmtBytes(s.disk_free_bytes)} free (${pct}% used)`);
    lines.push(`Data dir:  ${fmtBytes(s.data_dir_bytes)}`);
  }

  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
