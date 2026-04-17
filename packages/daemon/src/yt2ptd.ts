#!/usr/bin/env node

import { resolve } from "node:path";
import { loadConfig, createLogger, ensureDirs } from "@yt2pt/shared";
import { openDatabase } from "./db";
import { buildServer } from "./server";
import { JobQueue } from "./queue";
import { PeertubeConnection } from "./peertube/connection";
import { createProcessors } from "./workers";

async function main(): Promise<void> {
  const { config, paths } = loadConfig();
  ensureDirs(paths);

  const logger = createLogger(config);
  const db = openDatabase(paths);

  const peertube = new PeertubeConnection({
    config,
    logger,
    configPath: paths.configPath,
  });
  await peertube.start();
  const status = peertube.getStatus();
  logger.info(
    `PeerTube: instance=${status.instance_url || "(unset)"} online=${status.online} authenticated=${status.authenticated}${
      status.username ? ` user=${status.username}` : ""
    }`
  );

  // Build queue with real processors. `queue` is created before
  // processors because processors need a reference to it for progress
  // reporting; we wire via a lazy holder.
  let queueRef: JobQueue | null = null;
  const processors = createProcessors({
    db,
    config,
    paths,
    logger,
    peertube,
    // Proxy until queue is constructed; JobQueue.reportProgress is only
    // called from inside a running processor so the ref is always set by then.
    queue: new Proxy({} as JobQueue, {
      get: (_t, prop) => {
        if (!queueRef) throw new Error("queue not initialized");
        return (queueRef as unknown as Record<string | symbol, unknown>)[prop];
      },
    }),
  });
  const queue = new JobQueue({ db, config, logger, processors });
  queueRef = queue;
  queue.start();

  const webRoot = process.env.YT2PT_WEB_ROOT
    ? resolve(process.env.YT2PT_WEB_ROOT)
    : resolve(__dirname, "..", "..", "web", "dist");

  const app = buildServer({ config, paths, db, logger, peertube }, { webRoot });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down...`);
    try {
      peertube.stop();
      await queue.stop();
      await app.close();
      db.close();
      logger.info("Shutdown complete.");
      process.exit(0);
    } catch (err) {
      logger.error(`Shutdown error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  try {
    const address = await app.listen({ host: config.http.bind, port: config.http.port });
    logger.info(`yt2ptd listening on ${address}`);
    logger.info(`  data_dir: ${paths.dataDir}`);
    logger.info(`  log_dir:  ${paths.logDir}`);
    logger.info(`  db:       ${paths.dataDir}/yt2pt.db`);
  } catch (err) {
    logger.error(`Failed to start server: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
