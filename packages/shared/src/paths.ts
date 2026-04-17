import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

// ── Types ───────────────────────────────────────────────────────────

export type PathMode = "root" | "user" | "dev";

export interface ResolvedPaths {
  mode: PathMode;
  configPath: string;
  dataDir: string;
  logDir: string;
  binDir: string;
}

export interface PathOverrides {
  data_dir?: string;
  log_dir?: string;
}

// ── Dev mode detection ──────────────────────────────────────────────

// From packages/shared/dist/ back up to repo root
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

function isDevMode(): boolean {
  // Non-Linux platforms (macOS) always use dev mode.
  if (process.platform !== "linux") return true;
  // On Linux, fall back to dev mode if a local config file is present
  // in the repo root (useful when running from a clone without install).
  return existsSync(join(REPO_ROOT, "yt2pt.conf.toml"));
}

// ── Mode detection ──────────────────────────────────────────────────

function detectMode(): PathMode {
  if (isDevMode()) return "dev";
  // System/root mode if the system config file exists. This covers both
  // the classic case (running as root) and a systemd service running as
  // a dedicated non-root user (e.g. `yt2pt`) that has no writable home.
  if (existsSync("/etc/yt2pt/yt2pt.conf.toml")) return "root";
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  return uid === 0 ? "root" : "user";
}

// ── Default paths per mode ──────────────────────────────────────────

function defaultsFor(mode: PathMode): Omit<ResolvedPaths, "mode"> {
  switch (mode) {
    case "root":
      return {
        configPath: "/etc/yt2pt/yt2pt.conf.toml",
        dataDir: "/var/lib/yt2pt",
        logDir: "/var/log/yt2pt",
        binDir: "/usr/local/lib/yt2pt/bin",
      };
    case "user": {
      const home = homedir();
      return {
        configPath: join(home, ".config", "yt2pt", "yt2pt.conf.toml"),
        dataDir: join(home, ".local", "share", "yt2pt"),
        logDir: join(home, ".local", "share", "yt2pt", "logs"),
        binDir: join(home, ".local", "share", "yt2pt", "bin"),
      };
    }
    case "dev":
      return {
        configPath: join(REPO_ROOT, "yt2pt.conf.toml"),
        // Stable, separated dev-mode scratch paths so a zero-config run
        // doesn't bleed state into the repo working tree.
        dataDir: "/tmp/yt2ptd/data",
        logDir: "/tmp/yt2ptd/logs",
        binDir: join(REPO_ROOT, "bin"),
      };
  }
}

// ── Resolver ────────────────────────────────────────────────────────

/**
 * Resolve filesystem paths for yt2pt. Precedence (highest first):
 *   1. Config file values (data_dir, log_dir) — passed via overrides
 *   2. Environment variables (YT2PT_CONFIG, YT2PT_DATA_DIR, YT2PT_LOG_DIR)
 *   3. Auto-detected defaults per mode (root / user / dev)
 *
 * The config file path itself is resolved from env + auto only, since
 * config overrides cannot be read before the file is located.
 */
export function resolvePaths(overrides: PathOverrides = {}): ResolvedPaths {
  const mode = detectMode();
  const defaults = defaultsFor(mode);

  const configPath = process.env["YT2PT_CONFIG"] ?? defaults.configPath;
  const dataDir = overrides.data_dir ?? process.env["YT2PT_DATA_DIR"] ?? defaults.dataDir;
  const logDir = overrides.log_dir ?? process.env["YT2PT_LOG_DIR"] ?? defaults.logDir;
  const binDir = defaults.binDir;

  return { mode, configPath, dataDir, logDir, binDir };
}

// ── Directory creation ──────────────────────────────────────────────

/** Create data and log directories if they do not exist. */
export function ensureDirs(paths: ResolvedPaths): void {
  mkdirSync(paths.dataDir, { recursive: true });
  mkdirSync(paths.logDir, { recursive: true });
}
