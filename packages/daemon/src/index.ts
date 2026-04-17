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
