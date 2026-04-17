import type { Database } from "better-sqlite3";

// ── Video status enum ───────────────────────────────────────────────

export const VIDEO_STATUS = [
  "DOWNLOAD_QUEUED",
  "DOWNLOADING",
  "DOWNLOAD_FAILED",
  "CONVERT_QUEUED",
  "CONVERTING",
  "CONVERT_FAILED",
  "UPLOAD_QUEUED",
  "UPLOADING",
  "UPLOAD_FAILED",
  "UPLOADED",
] as const;

export type VideoStatus = (typeof VIDEO_STATUS)[number];

// ── Schema ──────────────────────────────────────────────────────────

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS channels (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  youtube_channel_url   TEXT NOT NULL,
  youtube_channel_name  TEXT,
  peertube_channel_id   TEXT NOT NULL,
  added_at              TEXT NOT NULL,
  last_synced_at        TEXT
);

CREATE TABLE IF NOT EXISTS videos (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  youtube_video_id  TEXT NOT NULL UNIQUE,
  channel_id        INTEGER NOT NULL,
  title             TEXT,
  status            TEXT NOT NULL,
  progress_pct      INTEGER NOT NULL DEFAULT 0,
  error_message     TEXT,
  folder_name       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
CREATE INDEX IF NOT EXISTS idx_videos_channel_id ON videos(channel_id);
CREATE INDEX IF NOT EXISTS idx_videos_youtube_video_id ON videos(youtube_video_id);
`;

// ── Migrations ──────────────────────────────────────────────────────

interface Migration {
  version: number;
  up: string;
}

const SCHEMA_V2 = `
ALTER TABLE videos ADD COLUMN upload_date TEXT;
CREATE INDEX IF NOT EXISTS idx_videos_upload_date ON videos(upload_date);
`;

const SCHEMA_V3 = `
ALTER TABLE videos ADD COLUMN peertube_video_uuid TEXT;
`;

const MIGRATIONS: Migration[] = [
  { version: 1, up: SCHEMA_V1 },
  { version: 2, up: SCHEMA_V2 },
  { version: 3, up: SCHEMA_V3 },
];

export function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );
  `);

  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null };
  const current = row.v ?? 0;

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.up);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(m.version);
    })();
  }
}
