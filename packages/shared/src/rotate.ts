import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Rotate a log file on startup using `.archive.N` suffixes:
 *
 *   yt2pt.log            (live file — will be opened fresh by the caller)
 *   yt2pt.log.archive.1  (previous run)
 *   yt2pt.log.archive.2  (the run before that)
 *   …
 *   yt2pt.log.archive.N  (N = maxArchives, oldest; anything older is dropped)
 *
 * Semantics: no-op if the live file is absent or empty (so repeated quick
 * restarts don't accumulate empty archives). Plain renames only — no
 * compression. Caller is responsible for (re)creating the live file.
 */
export function rotateLogFile(logFile: string, maxArchives = 10): void {
  if (maxArchives < 1) return;
  if (!existsSync(logFile)) return;
  try {
    if (statSync(logFile).size === 0) return;
  } catch {
    return;
  }

  mkdirSync(dirname(logFile), { recursive: true });

  const archive = (n: number): string => `${logFile}.archive.${n}`;

  // Drop anything older than maxArchives.
  if (existsSync(archive(maxArchives))) {
    try { rmSync(archive(maxArchives)); } catch { /* best effort */ }
  }

  // Shift descending: archive.N-1 → archive.N, …, archive.1 → archive.2.
  for (let i = maxArchives - 1; i >= 1; i--) {
    const src = archive(i);
    if (existsSync(src)) {
      try { renameSync(src, archive(i + 1)); } catch { /* best effort */ }
    }
  }

  // Live → archive.1.
  try { renameSync(logFile, archive(1)); } catch { /* best effort */ }
}
