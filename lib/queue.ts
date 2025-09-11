// lib/queue.ts
import { Queue } from "bullmq";
import IORedis from "ioredis";
import "dotenv/config";

const connection = new IORedis({
host: "159.65.154.159",
  port: 6379,
 password: "Pankajsoni1155@",
 maxRetriesPerRequest: null,
});

export const provisionQueue = new Queue("cluster", { connection });


//api-->queue--->

