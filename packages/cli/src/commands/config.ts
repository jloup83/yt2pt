import type { ApiClient } from "../api/client";
import { isJsonMode, paint, printJson } from "../output/format";

type ConfigSection = Record<string, unknown>;
type ConfigResponse = Record<string, ConfigSection>;

/** `yt2pt config` — print the full, redacted configuration. */
export async function runConfigGet(client: ApiClient): Promise<number> {
  const cfg = await client.request<ConfigResponse>("/api/settings");
  if (isJsonMode()) {
    printJson(cfg);
    return 0;
  }
  process.stdout.write(`${formatConfig(cfg)}\n`);
  return 0;
}

/** `yt2pt config <section.key> <value>` — patch a single setting. */
export async function runConfigSet(client: ApiClient, dottedKey: string, rawValue: string): Promise<number> {
  const [section, key] = parseKey(dottedKey);
  if (!section || !key) {
    process.stderr.write(`Error: key must be in 'section.key' form (e.g. peertube.privacy)\n`);
    return 1;
  }
  const value = coerceValue(rawValue);
  const patch = { [section]: { [key]: value } };

  const cfg = await client.request<ConfigResponse>("/api/settings", {
    method: "PUT",
    body: patch,
  });
  if (isJsonMode()) {
    printJson(cfg);
    return 0;
  }
  process.stdout.write(`${paint("✓", "green")} ${section}.${key} = ${formatValue(value)}\n`);
  return 0;
}

// ── Helpers ─────────────────────────────────────────────────────────

function parseKey(dotted: string): [string, string] {
  const idx = dotted.indexOf(".");
  if (idx <= 0 || idx === dotted.length - 1) return ["", ""];
  return [dotted.slice(0, idx), dotted.slice(idx + 1)];
}

/**
 * Coerce a CLI string into a typed value. `true`/`false` → boolean,
 * integer-looking → number, everything else → string. Users needing a
 * literal `"true"` string can set it via the API directly.
 */
export function coerceValue(raw: string): string | number | boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isSafeInteger(n)) return n;
  }
  return raw;
}

export function formatConfig(cfg: ConfigResponse): string {
  const lines: string[] = [];
  for (const [section, values] of Object.entries(cfg)) {
    lines.push(paint(`[${section}]`, "cyan"));
    const keys = Object.keys(values);
    const pad = Math.max(0, ...keys.map((k) => k.length));
    for (const k of keys) {
      lines.push(`  ${k.padEnd(pad)} = ${formatValue(values[k])}`);
    }
    lines.push("");
  }
  // Trim trailing blank
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return String(v);
}
