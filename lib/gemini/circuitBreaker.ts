import { getRecentModelFailureCount, log } from '@/lib/db/operations';

const FAILURE_THRESHOLD = 5;
const WINDOW_MINUTES = 15;

/**
 * Checks whether a model's circuit is OPEN (too many recent failures logged
 * for it) before spending time/tokens calling it again. Backed by system_logs
 * rather than in-memory state, since a serverless function's memory doesn't
 * survive between invocations - without this, a "circuit breaker" would
 * silently do nothing across separate cron runs.
 */
export async function isCircuitOpen(model: string): Promise<boolean> {
  const failures = await getRecentModelFailureCount(model, WINDOW_MINUTES);
  const open = failures >= FAILURE_THRESHOLD;

  if (open) {
    await log('WARN', 'AI', `Circuit breaker OPEN for ${model}: ${failures} failures in the last ${WINDOW_MINUTES}m, skipping`);
  }

  return open;
}
