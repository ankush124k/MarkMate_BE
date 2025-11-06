import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

import 'dotenv/config'; 

export const UPLOAD_QUEUE_NAME = 'upload-batch-queue';

// This is the FIXED code
// 1. Create a connection to Redis using the Upstash URL
const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  tls: {} // <-- Add this line to enable TLS
});

// 2. Create the Queue
// This is what your API will use to ADD jobs.
export const uploadQueue = new Queue(UPLOAD_QUEUE_NAME, { connection });

// 3. Create a Worker (for testing)
// This is what your Worker service will use to PROCESS jobs.
// We'll move this to a separate worker.js file later.
// For now, we'll put a simple test worker here.
export const setupTestWorker = () => {
  const worker = new Worker(UPLOAD_QUEUE_NAME, async (job) => {
    // --- This is where your Playwright bot logic will go ---
    
    console.log(`[Worker] 🚀 Processing job for batch ID: ${job.data.batchId}`);
    
    // Simulate a long-running bot process (e.g., 5 seconds)
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    console.log(`[Worker] ✅ Finished job for batch ID: ${job.data.batchId}`);
    
    // You can return a result
    return { success: true, candidatesProcessed: 50 };
  }, { connection });

  worker.on('completed', (job, result) => {
    console.log(`[Worker] Job ${job.id} completed! Result:`, result);
  });

  worker.on('failed', (job, err) => {
    console.error(`[Worker] Job ${job.id} failed:`, err);
  });
};