#!/usr/bin/env node

import { resolve, join } from "node:path";
import { networkInterfaces } from "node:os";
import { loadConfig, createLogger, ensureDirs, rotateLogFile } from "@yt2pt/shared";
import { openDatabase } from "./db";
import { buildServer } from "./server";
import { JobQueue } from "./queue";
import { PeertubeConnection } from "./peertube/connection";
import { createProcessors, findYtDlpBinary } from "./workers";
import { SyncEngine } from "./sync";

async function main(): Promise<void> {
  const { config, paths } = loadConfig();
  ensureDirs(paths);

  // Archive the previous run's log (if any) before we open a fresh one.
  rotateLogFile(join(paths.logDir, "yt2pt.log"));

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

  const sync = new SyncEngine({
    db,
    logger,
    queue,
    ytdlpBinary: () => findYtDlpBinary(paths.binDir),
    dataDir: paths.dataDir,
  });

  const webRoot = process.env.YT2PT_WEB_ROOT
    ? resolve(process.env.YT2PT_WEB_ROOT)
    : resolve(__dirname, "..", "..", "web", "dist");

  const app = buildServer({ config, paths, db, logger, peertube, queue, sync }, { webRoot });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      logger.error(`Received second ${signal}, forcing exit.`);
      process.exit(1);
    }
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down...`);
    // Hard-exit safety net: if graceful shutdown takes longer than 5s
    // (e.g. fastify keep-alive sockets, in-flight fetches), bail out.
    setTimeout(() => {
      logger.error("Graceful shutdown timed out after 5s, forcing exit.");
      process.exit(1);
    }, 5000);
    try {
      const t0 = Date.now();
      peertube.stop();
      logger.debug(`  peertube.stop  ${Date.now() - t0}ms`);
      const t1 = Date.now();
      sync.stopAll();
      logger.debug(`  sync.stopAll   ${Date.now() - t1}ms`);
      const t2 = Date.now();
      await queue.stop();
      logger.debug(`  queue.stop     ${Date.now() - t2}ms`);
      const t3 = Date.now();
      // Forcefully close keep-alive HTTP sockets so app.close() doesn't hang.
      app.server.closeAllConnections?.();
      await app.close();
      logger.debug(`  app.close      ${Date.now() - t3}ms`);
      const t4 = Date.now();
      db.close();
      logger.debug(`  db.close       ${Date.now() - t4}ms`);
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
    await app.listen({ host: config.http.bind, port: config.http.port });
    const bind = config.http.bind;
    const port = config.http.port;
    const isWildcard = bind === "0.0.0.0" || bind === "::" || bind === "*";
    if (isWildcard) {
      logger.info(`yt2ptd listening on http://${bind}:${port} (all interfaces)`);
      logger.info(`  local: http://127.0.0.1:${port}`);
      const lanAddresses: string[] = [];
      for (const ifaces of Object.values(networkInterfaces())) {
        for (const iface of ifaces ?? []) {
          if (iface.family === "IPv4" && !iface.internal) {
            lanAddresses.push(iface.address);
          }
        }
      }
      for (const addr of lanAddresses) {
        logger.info(`  lan:   http://${addr}:${port}`);
      }
    } else {
      logger.info(`yt2ptd listening on http://${bind}:${port}`);
    }
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
