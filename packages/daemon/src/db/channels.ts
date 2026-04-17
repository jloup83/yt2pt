import type { Database } from "better-sqlite3";

export interface Channel {
  id: number;
  youtube_channel_url: string;
  youtube_channel_name: string | null;
  peertube_channel_id: string;
  added_at: string;
  last_synced_at: string | null;
}

export interface InsertChannelInput {
  youtube_channel_url: string;
  youtube_channel_name?: string | null;
  peertube_channel_id: string;
}

export function insertChannel(db: Database, input: InsertChannelInput): Channel {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO channels (youtube_channel_url, youtube_channel_name, peertube_channel_id, added_at)
     VALUES (?, ?, ?, ?)`
  );
  const result = stmt.run(
    input.youtube_channel_url,
    input.youtube_channel_name ?? null,
    input.peertube_channel_id,
    now
  );
  return getChannelById(db, Number(result.lastInsertRowid))!;
}

export function getChannelById(db: Database, id: number): Channel | null {
  return (db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as Channel | undefined) ?? null;
}

export function getChannelByUrl(db: Database, url: string): Channel | null {
  return (db.prepare("SELECT * FROM channels WHERE youtube_channel_url = ?").get(url) as Channel | undefined) ?? null;
}

export function listChannels(db: Database): Channel[] {
  return db.prepare("SELECT * FROM channels ORDER BY added_at").all() as Channel[];
}

export function updateChannelLastSynced(db: Database, id: number, when: string = new Date().toISOString()): void {
  db.prepare("UPDATE channels SET last_synced_at = ? WHERE id = ?").run(when, id);
}

export function deleteChannel(db: Database, id: number): void {
  db.prepare("DELETE FROM channels WHERE id = ?").run(id);
}
