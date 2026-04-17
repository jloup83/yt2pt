import { readFileSync, writeFileSync } from "node:fs";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { Logger } from "./logger";
import { resolvePaths, type ResolvedPaths } from "./paths";

export function getConfigPath(): string {
  return resolvePaths().configPath;
}

// ── Interfaces ──────────────────────────────────────────────────────

interface Yt2ptConfig {
  data_dir: string;
  log_dir: string;
  log_level: string;
  overwrite_existing: boolean;
  skip_downloaded: boolean;
  remove_video_after_upload: boolean;
  remove_video_after_metadata_conversion: boolean;
}

interface HttpConfig {
  port: number;
  bind: string;
}

interface WorkersConfig {
  download_concurrency: number;
  convert_concurrency: number;
  upload_concurrency: number;
}

interface YtdlpConfig {
  format: string;
  merge_output_format: string;
  thumbnail_format: string;
}

interface PeertubeConfig {
  instance_url: string;
  api_token: string;
  channel_id: string;
  privacy: string;
  language: string;
  licence: string;
  comments_policy: string;
  wait_transcoding: boolean;
  generate_transcription: boolean;
}

export interface Config {
  yt2pt: Yt2ptConfig;
  http: HttpConfig;
  workers: WorkersConfig;
  ytdlp: YtdlpConfig;
  peertube: PeertubeConfig;
}

// ── Defaults ────────────────────────────────────────────────────────

const DEFAULTS: Config = {
  yt2pt: {
    data_dir: "",
    log_dir: "",
    log_level: "info",
    overwrite_existing: false,
    skip_downloaded: true,
    remove_video_after_upload: false,
    remove_video_after_metadata_conversion: false,
  },
  http: {
    port: 8090,
    bind: "0.0.0.0",
  },
  workers: {
    download_concurrency: 1,
    convert_concurrency: 1,
    upload_concurrency: 1,
  },
  ytdlp: {
    format: "bv*+ba/b",
    merge_output_format: "mkv",
    thumbnail_format: "jpg",
  },
  peertube: {
    instance_url: "",
    api_token: "",
    channel_id: "",
    privacy: "public",
    language: "",
    licence: "",
    comments_policy: "enabled",
    wait_transcoding: true,
    generate_transcription: true,
  },
};

// ── Loader ──────────────────────────────────────────────────────────

function deepMerge(defaults: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(overrides)) {
    if (
      key in defaults &&
      typeof defaults[key] === "object" && defaults[key] !== null && !Array.isArray(defaults[key]) &&
      typeof overrides[key] === "object" && overrides[key] !== null && !Array.isArray(overrides[key])
    ) {
      result[key] = deepMerge(defaults[key] as Record<string, unknown>, overrides[key] as Record<string, unknown>);
    } else {
      result[key] = overrides[key];
    }
  }
  return result;
}

export function loadConfig(): { config: Config; overrides: Set<string>; paths: ResolvedPaths } {
  const overrides = new Set<string>();

  // Resolve the config file path first (env + auto; config can't override its own location).
  const initial = resolvePaths();

  let userConfig: Record<string, unknown> = {};
  try {
    const raw = readFileSync(initial.configPath, "utf-8");
    userConfig = parseToml(raw) as Record<string, unknown>;
  } catch {
    // No config file or invalid TOML — use defaults
  }

  // Track which keys the user overrode
  for (const section of Object.keys(userConfig)) {
    const sectionObj = userConfig[section];
    if (typeof sectionObj === "object" && sectionObj !== null) {
      for (const key of Object.keys(sectionObj as Record<string, unknown>)) {
        overrides.add(`${section}.${key}`);
      }
    }
  }

  const merged = deepMerge(DEFAULTS as unknown as Record<string, unknown>, userConfig) as unknown as Config;

  // Re-resolve with config overrides (data_dir / log_dir from TOML win over env).
  const paths = resolvePaths({
    data_dir: merged.yt2pt.data_dir || undefined,
    log_dir: merged.yt2pt.log_dir || undefined,
  });

  // Fill in the effective resolved paths so callers (logger, workers, etc.) can read config.yt2pt.{data_dir,log_dir}.
  merged.yt2pt.data_dir = paths.dataDir;
  merged.yt2pt.log_dir = paths.logDir;

  return { config: merged, overrides, paths };
}

// ── Writer ──────────────────────────────────────────────────────────

export function saveConfig(config: Config, configPath?: string): void {
  const target = configPath ?? resolvePaths().configPath;
  writeFileSync(target, stringifyToml(config as unknown as Record<string, unknown>) + "\n", "utf-8");
}

// ── Printer ─────────────────────────────────────────────────────────

export function printConfig(config: Config, overrides: Set<string>, log: Logger): void {
  log.info("Configuration:");

  for (const [section, values] of Object.entries(config)) {
    log.info(`  [${section}]`);
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      const path = `${section}.${key}`;
      const tag = overrides.has(path) ? "(custom)" : "(default)";
      const display = typeof value === "string" && value === "" ? '""' : String(value);
      log.info(`    ${key} = ${display} ${tag}`);
    }
  }
}
