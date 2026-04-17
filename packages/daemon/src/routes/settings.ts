import type { FastifyInstance } from "fastify";
import type { Config } from "@yt2pt/shared";
import { saveConfig } from "@yt2pt/shared";
import type { ServerContext } from "../server";

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
const PRIVACIES = ["public", "unlisted", "private", "internal", "password_protected"] as const;
const COMMENTS_POLICIES = ["enabled", "disabled", "requires_approval"] as const;

const TOKEN_MASK = "****";

// ── Redaction ───────────────────────────────────────────────────────

/**
 * Return a copy of the config safe to send over the wire — the PeerTube
 * API token is replaced with a fixed mask (non-empty when a token is set,
 * empty string when none).
 */
export function redactConfig(config: Config): Config {
  return {
    ...config,
    peertube: {
      ...config.peertube,
      api_token: config.peertube.api_token ? TOKEN_MASK : "",
    },
  };
}

// ── Validation ──────────────────────────────────────────────────────

export interface ValidationError {
  path: string;
  message: string;
}

type Section = keyof Config;
type PartialConfig = {
  [K in Section]?: Partial<Config[K]>;
};

/**
 * Validate a partial config patch. Returns the list of problems (empty
 * when valid). Unknown sections or keys are rejected to catch typos.
 */
export function validatePatch(patch: unknown, current: Config): ValidationError[] {
  const errs: ValidationError[] = [];
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return [{ path: "", message: "body must be a JSON object" }];
  }
  const p = patch as Record<string, unknown>;
  const allowedSections = Object.keys(current) as Section[];

  for (const section of Object.keys(p)) {
    if (!allowedSections.includes(section as Section)) {
      errs.push({ path: section, message: `unknown section '${section}'` });
      continue;
    }
    const sec = p[section];
    if (!sec || typeof sec !== "object" || Array.isArray(sec)) {
      errs.push({ path: section, message: `'${section}' must be an object` });
      continue;
    }
    const currentSection = current[section as Section] as unknown as Record<string, unknown>;
    for (const key of Object.keys(sec as Record<string, unknown>)) {
      if (!(key in currentSection)) {
        errs.push({ path: `${section}.${key}`, message: `unknown key '${section}.${key}'` });
      }
    }
  }

  if (errs.length > 0) return errs;

  // Type / range checks on the known fields only.
  const push = (path: string, message: string): void => {
    errs.push({ path, message });
  };
  const check = <T>(section: Section, key: string, validator: (v: unknown) => T | undefined, onBad: string): void => {
    const sec = (p as PartialConfig)[section] as Record<string, unknown> | undefined;
    if (!sec || !(key in sec)) return;
    if (validator(sec[key]) === undefined) push(`${section}.${key}`, onBad);
  };

  const isBool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
  const isStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const isInt = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isInteger(v) ? v : undefined;
  const enumOf = <T extends readonly string[]>(choices: T) => (v: unknown): T[number] | undefined =>
    typeof v === "string" && (choices as readonly string[]).includes(v) ? (v as T[number]) : undefined;

  // [yt2pt]
  check("yt2pt", "data_dir", isStr, "must be a string");
  check("yt2pt", "log_dir", isStr, "must be a string");
  check("yt2pt", "log_level", enumOf(LOG_LEVELS), `must be one of ${LOG_LEVELS.join(", ")}`);
  for (const k of ["overwrite_existing", "skip_downloaded", "remove_video_after_upload", "remove_video_after_metadata_conversion"] as const) {
    check("yt2pt", k, isBool, "must be boolean");
  }

  // [http]
  {
    const http = (p as PartialConfig).http;
    if (http && "port" in http) {
      const port = http.port;
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
        push("http.port", "must be an integer in 1..65535");
      }
    }
    check("http", "bind", isStr, "must be a string");
  }

  // [workers]
  for (const k of ["download_concurrency", "convert_concurrency", "upload_concurrency"] as const) {
    const workers = (p as PartialConfig).workers;
    if (workers && k in workers) {
      const v = workers[k];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 32) {
        push(`workers.${k}`, "must be an integer in 1..32");
      }
    }
  }

  // [ytdlp]
  for (const k of ["format", "merge_output_format", "thumbnail_format"] as const) {
    check("ytdlp", k, isStr, "must be a string");
  }

  // [peertube]
  check("peertube", "instance_url", isStr, "must be a string");
  check("peertube", "api_token", isStr, "must be a string");
  check("peertube", "channel_id", isStr, "must be a string");
  check("peertube", "language", isStr, "must be a string");
  check("peertube", "licence", isStr, "must be a string");
  check("peertube", "privacy", enumOf(PRIVACIES), `must be one of ${PRIVACIES.join(", ")}`);
  check("peertube", "comments_policy", enumOf(COMMENTS_POLICIES), `must be one of ${COMMENTS_POLICIES.join(", ")}`);
  check("peertube", "wait_transcoding", isBool, "must be boolean");
  check("peertube", "generate_transcription", isBool, "must be boolean");

  // Reject masked token — the PUT endpoint must not persist the literal mask
  // as an actual token value. Clients wanting to keep the existing token
  // simply omit the field.
  const pt = (p as PartialConfig).peertube;
  if (pt && typeof pt.api_token === "string" && pt.api_token === TOKEN_MASK) {
    push("peertube.api_token", `use POST /api/settings/token to set a token (or omit to keep current)`);
  }

  return errs;
}

// ── Merging ─────────────────────────────────────────────────────────

/**
 * Produce a new Config by merging validated patch sections into `current`.
 * Assumes patch has already passed `validatePatch`.
 */
export function mergeConfig(current: Config, patch: PartialConfig): Config {
  const next: Config = {
    yt2pt: { ...current.yt2pt },
    http: { ...current.http },
    workers: { ...current.workers },
    ytdlp: { ...current.ytdlp },
    peertube: { ...current.peertube },
  };
  for (const section of Object.keys(patch) as Section[]) {
    const sec = patch[section];
    if (!sec) continue;
    Object.assign(next[section] as unknown as Record<string, unknown>, sec);
  }
  return next;
}

// ── Routes ──────────────────────────────────────────────────────────

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  const ctx: ServerContext = app.ctx;

  app.get("/api/settings", async () => redactConfig(ctx.config));

  app.put("/api/settings", async (req, reply) => {
    const errs = validatePatch(req.body, ctx.config);
    if (errs.length > 0) {
      reply.code(400);
      return { error: "validation failed", details: errs };
    }

    const patch = req.body as PartialConfig;
    const next = mergeConfig(ctx.config, patch);

    try {
      saveConfig(next, ctx.paths.configPath);
    } catch (err) {
      ctx.logger.error(`Failed to save config: ${err instanceof Error ? err.message : String(err)}`);
      reply.code(500);
      return { error: "failed to write config" };
    }

    // Mutate the in-process config object so everything pointing at it
    // (queue, peertube, logger config) sees the new values without a restart.
    Object.assign(ctx.config.yt2pt, next.yt2pt);
    Object.assign(ctx.config.http, next.http);
    Object.assign(ctx.config.workers, next.workers);
    Object.assign(ctx.config.ytdlp, next.ytdlp);
    Object.assign(ctx.config.peertube, next.peertube);

    // If instance_url changed, force a connection refresh on next tick.
    if (ctx.peertube && patch.peertube && "instance_url" in patch.peertube) {
      // fire-and-forget; errors are surfaced via GET /api/peertube later.
      void ctx.peertube.refresh();
    }

    return redactConfig(ctx.config);
  });

  app.post("/api/settings/token", async (req, reply) => {
    const body = req.body as { username?: unknown; password?: unknown } | undefined;
    const username = typeof body?.username === "string" ? body.username : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!username || !password) {
      reply.code(400);
      return { success: false, error: "username and password are required" };
    }
    if (!ctx.peertube) {
      reply.code(503);
      return { success: false, error: "peertube connection not initialized" };
    }
    const result = await ctx.peertube.acquireToken(username, password);
    if (!result.success) {
      reply.code(401);
      return { success: false, error: result.error ?? "authentication failed" };
    }
    return { success: true, token: TOKEN_MASK };
  });
}

export const __test = { TOKEN_MASK };
