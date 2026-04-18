// ── Create-PeerTube-channel-from-YouTube orchestration ──────────────
//
// Builds a PeerTube channel-creation payload from yt-dlp's channel
// metadata, stages the assets (avatar, banner, payload JSON) under
// `<dataDir>/upload_to_peertube/<slug>/channel_info/`, then drives the
// PeerTube API to create the channel and attach its avatar + banner.
//
// All network calls go through `PeertubeConnection.authFetch` so the
// existing 401-retry + token logic applies.

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type { Logger } from "@yt2pt/shared";
import { youtubeHandle } from "../workers/paths";
import type { PeertubeConnection } from "./connection";

// ── Payload shape ───────────────────────────────────────────────────

export interface PeertubeChannelPayload {
  /** Slug — `[a-z0-9_.]{1,50}`. Used in the URL. */
  name: string;
  /** Free-form display name shown in the UI (1-50 chars). */
  displayName: string;
  /** Long description (≤ 1000 chars). May be empty string. */
  description: string;
  /** "Support" text (links to crowdfunding etc.). May be empty. */
  support: string;
}

export interface BuildPayloadOverrides {
  name?: string;
  displayName?: string;
  description?: string;
  support?: string;
}

// PeerTube limits.
const PT_NAME_MAX = 50;
const PT_DISPLAY_MAX = 50;
const PT_DESC_MAX = 1000;
const PT_SUPPORT_MAX = 1000;

/** Produce a PeerTube-compatible slug: `[a-z0-9_.]{1,50}`. */
export function slugifyForPeertube(input: string): string {
  const norm = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")    // strip combining accents
    .toLowerCase();
  let out = "";
  for (const ch of norm) {
    if (/[a-z0-9_.]/.test(ch)) out += ch;
    else if (/[\s\-]/.test(ch)) out += "_";
    // everything else is dropped
  }
  // Collapse runs of underscore / dot, trim leading/trailing punctuation.
  out = out.replace(/[_.]{2,}/g, "_").replace(/^[_.]+|[_.]+$/g, "");
  if (!out) out = "channel";
  return out.slice(0, PT_NAME_MAX);
}

/**
 * Build a PeerTube channel-creation payload from a yt-dlp channel
 * metadata blob (the same JSON written by `fetchChannelInfo`).
 */
export function buildPeertubeChannelPayload(
  ytdlpMeta: Record<string, unknown>,
  overrides: BuildPayloadOverrides = {},
): PeertubeChannelPayload {
  const rawName =
    (ytdlpMeta["channel"] as string | undefined)
    ?? (ytdlpMeta["uploader"] as string | undefined)
    ?? (ytdlpMeta["title"] as string | undefined)
    ?? "channel";

  const channelUrl =
    (ytdlpMeta["channel_url"] as string | undefined)
    ?? (ytdlpMeta["uploader_url"] as string | undefined)
    ?? (ytdlpMeta["webpage_url"] as string | undefined)
    ?? "";

  const description =
    (ytdlpMeta["description"] as string | undefined)
    ?? (ytdlpMeta["channel_description"] as string | undefined)
    ?? "";

  const handle = youtubeHandle(ytdlpMeta);
  const name = overrides.name?.trim() || slugifyForPeertube(handle ?? rawName);
  const displayName = (overrides.displayName?.trim() || rawName).slice(0, PT_DISPLAY_MAX);
  const desc = (overrides.description ?? description).slice(0, PT_DESC_MAX);
  const support = (overrides.support ?? `Mirrored from ${channelUrl}`).slice(0, PT_SUPPORT_MAX);

  return {
    name: validateSlug(name),
    displayName,
    description: desc,
    support,
  };
}

function validateSlug(slug: string): string {
  if (!/^[a-z0-9_.]{1,50}$/.test(slug)) {
    throw new Error(
      `invalid PeerTube channel slug "${slug}": must match [a-z0-9_.] and be 1-50 chars`
    );
  }
  return slug;
}

// ── Staging on disk ─────────────────────────────────────────────────

export interface StagedChannelAssets {
  dir: string;
  metadataPath: string;
  avatarPath: string | null;
  bannerPath: string | null;
}

/**
 * Copy avatar + banner from the downloaded_from_youtube/<slug>/channel_info
 * directory into upload_to_peertube/<slug>/channel_info, and write the
 * PeerTube payload as `metadata.json`. Returns the staged paths.
 */
export async function stagePeertubeChannelAssets(
  dataDir: string,
  ytSlug: string,
  payload: PeertubeChannelPayload,
  sources: { avatar: string | null; banner: string | null },
): Promise<StagedChannelAssets> {
  const dir = resolve(dataDir, "upload_to_peertube", ytSlug, "channel_info");
  await mkdir(dir, { recursive: true });

  const metadataPath = join(dir, "metadata.json");
  await writeFile(metadataPath, JSON.stringify(payload, null, 2), "utf-8");

  let avatarPath: string | null = null;
  if (sources.avatar) {
    const target = join(dir, `avatar${extname(sources.avatar) || ".jpg"}`);
    await copyFile(sources.avatar, target);
    avatarPath = target;
  }
  let bannerPath: string | null = null;
  if (sources.banner) {
    const target = join(dir, `banner${extname(sources.banner) || ".jpg"}`);
    await copyFile(sources.banner, target);
    bannerPath = target;
  }
  return { dir, metadataPath, avatarPath, bannerPath };
}

// ── PeerTube API calls ──────────────────────────────────────────────

export interface CreatedPeertubeChannel {
  id: number;
  name: string;
  displayName: string;
}

export class PeertubeApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "PeertubeApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Create a video channel via PeerTube's REST API. Surfaces 409 / 400 with
 * the parsed body so callers can react (e.g. ask the user for a different
 * slug).
 */
export async function createPeertubeChannel(
  pt: PeertubeConnection,
  payload: PeertubeChannelPayload,
): Promise<CreatedPeertubeChannel> {
  // PeerTube's video-channels endpoint rejects empty `description` /
  // `support` fields with 400 "Invalid value", so omit them when empty
  // rather than sending "".
  const reqBody: Record<string, string> = {
    name: payload.name,
    displayName: payload.displayName,
  };
  if (payload.description.trim().length > 0) reqBody["description"] = payload.description;
  if (payload.support.trim().length > 0) reqBody["support"] = payload.support;

  const res = await pt.authFetch("/video-channels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reqBody),
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw new PeertubeApiError(
      `PeerTube channel creation failed (${res.status})`,
      res.status,
      body,
    );
  }
  // PeerTube returns { videoChannel: { id, name, displayName } } on
  // success; the channel summary comes back via a separate GET.
  const created = (body as { videoChannel?: { id: number } } | null)?.videoChannel;
  if (!created || typeof created.id !== "number") {
    throw new PeertubeApiError(
      "PeerTube channel creation returned no videoChannel.id",
      res.status,
      body,
    );
  }

  // Fetch the full record so we have a confirmed displayName.
  const get = await pt.authFetch(`/video-channels/${payload.name}`);
  const detail = (await get.json().catch(() => null)) as
    { id?: number; name?: string; displayName?: string } | null;
  return {
    id: detail?.id ?? created.id,
    name: detail?.name ?? payload.name,
    displayName: detail?.displayName ?? payload.displayName,
  };
}

/**
 * Upload an image (avatar or banner) for a video channel using
 * PeerTube's `pick` endpoint.
 */
export async function uploadChannelImage(
  pt: PeertubeConnection,
  channelHandle: string,
  kind: "avatar" | "banner",
  filePath: string,
): Promise<void> {
  const buf = await readFile(filePath);
  const fileField = kind === "avatar" ? "avatarfile" : "bannerfile";
  const filename = basename(filePath);
  const mime = mimeForExt(extname(filename));
  const blob = new Blob([buf], { type: mime });
  const form = new FormData();
  form.set(fileField, blob, filename);

  const res = await pt.authFetch(
    `/video-channels/${channelHandle}/${kind}/pick`,
    { method: "POST", body: form },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new PeertubeApiError(
      `PeerTube ${kind} upload failed (${res.status})`,
      res.status,
      body,
    );
  }
}

function mimeForExt(ext: string): string {
  const e = ext.toLowerCase().replace(/^\./, "");
  if (e === "jpg" || e === "jpeg") return "image/jpeg";
  if (e === "png") return "image/png";
  if (e === "webp") return "image/webp";
  if (e === "gif") return "image/gif";
  return "application/octet-stream";
}

// ── Top-level orchestrator ──────────────────────────────────────────

export interface CreateChannelFromYoutubeArgs {
  pt: PeertubeConnection;
  logger: Logger;
  dataDir: string;
  /** Result from `fetchChannelInfo()` — disk paths + slug. */
  channelInfo: {
    slug: string;
    metadataPath: string;
    avatarPath: string | null;
    bannerPath: string | null;
  };
  overrides?: BuildPayloadOverrides;
}

export interface CreateChannelFromYoutubeResult {
  payload: PeertubeChannelPayload;
  staged: StagedChannelAssets;
  created: CreatedPeertubeChannel;
  /** Non-fatal upload errors (avatar / banner). */
  warnings: string[];
}

export async function createChannelFromYoutube(
  args: CreateChannelFromYoutubeArgs,
): Promise<CreateChannelFromYoutubeResult> {
  const meta = JSON.parse(await readFile(args.channelInfo.metadataPath, "utf-8")) as
    Record<string, unknown>;
  const payload = buildPeertubeChannelPayload(meta, args.overrides);

  const staged = await stagePeertubeChannelAssets(
    args.dataDir,
    args.channelInfo.slug,
    payload,
    {
      avatar: args.channelInfo.avatarPath,
      banner: args.channelInfo.bannerPath,
    },
  );

  const created = await createPeertubeChannel(args.pt, payload);
  args.logger.info(`Created PeerTube channel ${created.name} (#${created.id})`);

  const warnings: string[] = [];
  if (staged.avatarPath) {
    try {
      await uploadChannelImage(args.pt, created.name, "avatar", staged.avatarPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      args.logger.error(`avatar upload failed: ${msg}`);
      warnings.push(`avatar upload failed: ${msg}`);
    }
  }
  if (staged.bannerPath) {
    try {
      await uploadChannelImage(args.pt, created.name, "banner", staged.bannerPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      args.logger.error(`banner upload failed: ${msg}`);
      warnings.push(`banner upload failed: ${msg}`);
    }
  }

  return { payload, staged, created, warnings };
}
