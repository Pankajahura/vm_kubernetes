// scripts/job-debug.ts
import 'dotenv/config';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const JOB_ID = process.argv[2];
if (!JOB_ID) {
  console.error('Usage: tsx scripts/job-debug.ts <jobId>');
  process.exit(1);
}

const connection = new IORedis(process.env.REDIS_URL!);
const q = new Queue('cluster', { connection });

(async () => {
  const job = await q.getJob(JOB_ID);
  if (!job) {
    console.log('No such job');
    process.exit(0);
  }
  const state = await job.getState();
  console.log({ id: job.id, state });
  console.log('failedReason:', job.failedReason);
  console.log('stacktrace:', job.stacktrace);
  console.log('data:', job.data);
  console.log('returnvalue:', job.returnvalue);
  process.exit(0);
})();
