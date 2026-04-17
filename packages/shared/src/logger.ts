import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Config } from "./config";

// ── Log levels ──────────────────────────────────────────────────────

const LOG_LEVELS = { error: 0, info: 1, debug: 2 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

// ── Colors (when terminal supports it) ──────────────────────────────

const supportsColor = process.stderr.isTTY && process.stdout.isTTY;

const colors = {
  red: supportsColor ? "\x1b[31m" : "",
  yellow: supportsColor ? "\x1b[33m" : "",
  cyan: supportsColor ? "\x1b[36m" : "",
  dim: supportsColor ? "\x1b[2m" : "",
  reset: supportsColor ? "\x1b[0m" : "",
};

// ── Logger ──────────────────────────────────────────────────────────

export class Logger {
  private level: number;
  private logFile: string;

  constructor(level: LogLevel, logFile: string) {
    this.level = LOG_LEVELS[level] ?? LOG_LEVELS.info;
    this.logFile = resolve(logFile);
    mkdirSync(dirname(this.logFile), { recursive: true });
  }

  error(message: string): void {
    this.writeFile("ERROR", message);
    process.stderr.write(`${colors.red}[ERROR]${colors.reset} ${message}\n`);
  }

  info(message: string): void {
    if (this.level < LOG_LEVELS.info) return;
    this.writeFile("INFO", message);
    process.stdout.write(`${colors.cyan}[INFO]${colors.reset}  ${message}\n`);
  }

  debug(message: string): void {
    if (this.level < LOG_LEVELS.debug) return;
    this.writeFile("DEBUG", message);
    process.stdout.write(`${colors.dim}[DEBUG] ${message}${colors.reset}\n`);
  }

  private writeFile(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    const line = `${timestamp} [${level}] ${message}\n`;
    try {
      appendFileSync(this.logFile, line);
    } catch {
      // Silently ignore file write errors
    }
  }
}

// ── Factory ─────────────────────────────────────────────────────────

export function createLogger(config: Config): Logger {
  const level = (config.yt2pt.log_level as LogLevel) || "info";
  const logFile = resolve(config.yt2pt.log_dir || config.yt2pt.data_dir, "yt2pt.log");
  return new Logger(level, logFile);
}
