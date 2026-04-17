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
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
