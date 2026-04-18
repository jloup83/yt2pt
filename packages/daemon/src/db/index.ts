import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { ResolvedPaths } from "@yt2pt/shared";
import { runMigrations } from "./schema";

export function openDatabase(paths: ResolvedPaths, filename = "yt2pt.db"): DB {
  mkdirSync(paths.dataDir, { recursive: true });
  const dbPath = join(paths.dataDir, filename);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

export type { DB as Database };
