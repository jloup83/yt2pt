export { downloadFromYouTube } from "./download";
export { convertMetadata } from "./convert";
export { uploadToPeertube } from "./upload";

export { openDatabase } from "./db";
export type { Database } from "./db";
export { runMigrations, VIDEO_STATUS } from "./db/schema";
export type { VideoStatus } from "./db/schema";
export * as channels from "./db/channels";
export * as videos from "./db/videos";
export type { Channel, InsertChannelInput } from "./db/channels";
export type { Video, InsertVideoInput, UpdateVideoInput } from "./db/videos";

export { buildServer } from "./server";
export type { ServerContext, BuildServerOptions } from "./server";

export { JobQueue } from "./queue";
export type { JobQueueOptions, JobQueueProcessors } from "./queue";
export { QueueEvents } from "./queue/events";
export type { QueueEventMap } from "./queue/events";
export { WorkerPool } from "./queue/pool";
export type { JobProcessor, WorkerPoolOptions } from "./queue/pool";
export { STAGES, claimNextJob, markJobSucceeded, markJobFailed, resetStaleJobs } from "./queue/transitions";
export type { Stage } from "./queue/transitions";

export { PeertubeConnection } from "./peertube/connection";
export type {
  ConnectionStatus,
  AcquireTokenResult,
  PeertubeConnectionOptions,
} from "./peertube/connection";

export { createProcessors, runDownload, runConvert, runUpload, findYtDlpBinary, channelSlugFromFolderName, youtubeUrl } from "./workers";
export type { ProcessorContext, Processors, DownloadResult } from "./workers";

export { registerSettingsRoutes, redactConfig, validatePatch, mergeConfig } from "./routes/settings";
export type { ValidationError } from "./routes/settings";

export { registerPeertubeRoutes, fetchUserChannels } from "./routes/peertube";
export type { PeertubeChannel } from "./routes/peertube";
