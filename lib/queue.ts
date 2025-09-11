// lib/queue.ts
import { Queue } from "bullmq";
import IORedis from "ioredis";

export const redis = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const g = globalThis as any;
export const provisionQueue: Queue =
  g.__provisionQueue ||
  (g.__provisionQueue = new Queue(process.env.QUEUE_NAME ?? "provision-queue", {
    connection: redis,
    defaultJobOptions: { removeOnComplete: true, attempts: 1 },
  }));
