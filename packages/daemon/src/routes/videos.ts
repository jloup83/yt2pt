import type { FastifyInstance } from "fastify";
import type { Database } from "better-sqlite3";
import type { ServerContext } from "../server";
import { VIDEO_STATUS, type VideoStatus } from "../db/schema";

export interface VideoWithChannel {
  id: number;
  youtube_video_id: string;
  channel_id: number;
  channel_name: string | null;
  title: string | null;
  status: VideoStatus;
  progress_pct: number;
  error_message: string | null;
  folder_name: string | null;
  created_at: string;
  updated_at: string;
}

const SORT_COLUMNS = new Set(["updated_at", "created_at", "title"]);
const VALID_STATUSES: Set<string> = new Set(VIDEO_STATUS);

export interface ListVideosParams {
  channelId?: number;
  statuses?: VideoStatus[];
  page: number;
  perPage: number;
  sort: "updated_at" | "created_at" | "title";
  order: "asc" | "desc";
}

export interface ListVideosResult {
  videos: VideoWithChannel[];
  total: number;
  page: number;
  per_page: number;
}

const SELECT_WITH_CHANNEL = `
  SELECT v.id, v.youtube_video_id, v.channel_id,
         c.youtube_channel_name AS channel_name,
         v.title, v.status, v.progress_pct, v.error_message,
         v.folder_name, v.created_at, v.updated_at
  FROM videos v
  LEFT JOIN channels c ON c.id = v.channel_id
`;

export function listVideosWithChannel(db: Database, params: ListVideosParams): ListVideosResult {
  const wheres: string[] = [];
  const args: unknown[] = [];
  if (params.channelId !== undefined) {
    wheres.push("v.channel_id = ?");
    args.push(params.channelId);
  }
  if (params.statuses && params.statuses.length > 0) {
    wheres.push(`v.status IN (${params.statuses.map(() => "?").join(",")})`);
    args.push(...params.statuses);
  }
  const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";

  const total = (db
    .prepare(`SELECT COUNT(*) AS n FROM videos v ${whereSql}`)
    .get(...args) as { n: number }).n;

  const offset = (params.page - 1) * params.perPage;
  const rows = db
    .prepare(
      `${SELECT_WITH_CHANNEL}
       ${whereSql}
       ORDER BY v.${params.sort} ${params.order === "asc" ? "ASC" : "DESC"}, v.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...args, params.perPage, offset) as VideoWithChannel[];

  return { videos: rows, total, page: params.page, per_page: params.perPage };
}

export function getVideoWithChannel(db: Database, id: number): VideoWithChannel | null {
  return (
    (db
      .prepare(`${SELECT_WITH_CHANNEL} WHERE v.id = ?`)
      .get(id) as VideoWithChannel | undefined) ?? null
  );
}

/** Parse a ?status=A,B,C string into a validated status list. Returns null if any token is unknown. */
export function parseStatuses(raw: string | undefined): VideoStatus[] | null | undefined {
  if (raw === undefined || raw === "") return undefined;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  for (const s of parts) if (!VALID_STATUSES.has(s)) return null;
  return parts as VideoStatus[];
}

export async function registerVideoRoutes(app: FastifyInstance): Promise<void> {
  const ctx: ServerContext = app.ctx;

  app.get("/api/videos", async (req, reply) => {
    const q = (req.query ?? {}) as {
      channel?: string;
      status?: string;
      page?: string;
      per_page?: string;
      sort?: string;
      order?: string;
    };

    let channelId: number | undefined;
    if (q.channel !== undefined && q.channel !== "") {
      const n = Number(q.channel);
      if (!Number.isInteger(n) || n <= 0) {
        reply.code(400);
        return { error: "invalid channel id" };
      }
      channelId = n;
    }

    const statuses = parseStatuses(q.status);
    if (statuses === null) {
      reply.code(400);
      return { error: "invalid status filter" };
    }

    const page = q.page ? Math.max(1, Number(q.page) | 0) : 1;
    const perPageRaw = q.per_page ? Number(q.per_page) | 0 : 50;
    const perPage = Math.max(1, Math.min(200, perPageRaw));

    const sort = SORT_COLUMNS.has(q.sort ?? "") ? (q.sort as "updated_at" | "created_at" | "title") : "updated_at";
    const order = q.order === "asc" ? "asc" : "desc";

    return listVideosWithChannel(ctx.db, {
      channelId,
      statuses: statuses ?? undefined,
      page,
      perPage,
      sort,
      order,
    });
  });

  app.get("/api/videos/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(400);
      return { error: "invalid id" };
    }
    const row = getVideoWithChannel(ctx.db, id);
    if (!row) {
      reply.code(404);
      return { error: "not found" };
    }
    return row;
  });
}
