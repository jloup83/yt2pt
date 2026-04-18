import type { Database } from "better-sqlite3";
import type { VideoStatus } from "./schema";

export interface Video {
  id: number;
  youtube_video_id: string;
  channel_id: number;
  title: string | null;
  status: VideoStatus;
  progress_pct: number;
  error_message: string | null;
  folder_name: string | null;
  upload_date: string | null;
  peertube_video_uuid: string | null;
  created_at: string;
  updated_at: string;
}

export interface InsertVideoInput {
  youtube_video_id: string;
  channel_id: number;
  title?: string | null;
  status: VideoStatus;
  folder_name?: string | null;
  upload_date?: string | null;
}

export function insertVideo(db: Database, input: InsertVideoInput): Video {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO videos (youtube_video_id, channel_id, title, status, folder_name, upload_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const result = stmt.run(
    input.youtube_video_id,
    input.channel_id,
    input.title ?? null,
    input.status,
    input.folder_name ?? null,
    input.upload_date ?? null,
    now,
    now
  );
  return getVideoById(db, Number(result.lastInsertRowid))!;
}

export function getVideoById(db: Database, id: number): Video | null {
  return (db.prepare("SELECT * FROM videos WHERE id = ?").get(id) as Video | undefined) ?? null;
}

export function getVideoByYoutubeId(db: Database, youtubeVideoId: string): Video | null {
  return (db.prepare("SELECT * FROM videos WHERE youtube_video_id = ?").get(youtubeVideoId) as Video | undefined) ?? null;
}

export function listVideos(db: Database): Video[] {
  return db.prepare("SELECT * FROM videos ORDER BY created_at DESC").all() as Video[];
}

export function listVideosByStatus(db: Database, status: VideoStatus): Video[] {
  return db.prepare("SELECT * FROM videos WHERE status = ? ORDER BY created_at").all(status) as Video[];
}

export function listVideosByChannel(db: Database, channelId: number): Video[] {
  return db.prepare("SELECT * FROM videos WHERE channel_id = ? ORDER BY created_at DESC").all(channelId) as Video[];
}

export interface UpdateVideoInput {
  status?: VideoStatus;
  progress_pct?: number;
  error_message?: string | null;
  title?: string | null;
  folder_name?: string | null;
  peertube_video_uuid?: string | null;
}

export function updateVideo(db: Database, id: number, input: UpdateVideoInput): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    fields.push(`${key} = ?`);
    values.push(value);
  }
  if (fields.length === 0) return;
  fields.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(id);
  db.prepare(`UPDATE videos SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

export function deleteVideo(db: Database, id: number): void {
  db.prepare("DELETE FROM videos WHERE id = ?").run(id);
}
