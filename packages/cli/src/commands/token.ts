import type { ApiClient } from "../api/client";
import { isJsonMode, paint, printJson } from "../output/format";

interface TokenResponse {
  success: boolean;
  token?: string;
  error?: string;
}

/** `yt2pt token <username> <password>` — exchange credentials for an API token. */
export async function runToken(client: ApiClient, username: string, password: string): Promise<number> {
  const res = await client.request<TokenResponse>("/api/settings/token", {
    method: "POST",
    body: { username, password },
  });

  if (isJsonMode()) {
    printJson(res);
    return res.success ? 0 : 1;
  }
  if (res.success) {
    process.stdout.write(`${paint("✓", "green")} Token acquired and stored.\n`);
    return 0;
  }
  process.stderr.write(`${paint("✗", "red")} ${res.error ?? "authentication failed"}\n`);
  return 1;
}
