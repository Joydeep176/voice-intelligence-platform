/**
 * Enqueues one foundation check job and waits for the orchestrator to process it.
 * Demonstrates the BullMQ boundary (API → orchestrator). It does not process audio.
 * Usage: pnpm --filter @vip/api run foundation-check (orchestrator must be running).
 */
import { loadConfig } from '../config/app-config';
import { FoundationCheckProducer } from '../queue/foundation-check.producer';

async function run(): Promise<void> {
  const producer = new FoundationCheckProducer(loadConfig(process.env));
  try {
    const { jobId } = await producer.enqueue();
    const result = await producer.waitForResult(jobId, 15_000);
    process.stdout.write(`${JSON.stringify({ ok: true, jobId, result })}\n`);
  } finally {
    await producer.close();
  }
}

run().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: (error as Error).name })}\n`);
  process.exit(1);
});
