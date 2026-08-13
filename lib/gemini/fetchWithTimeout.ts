// Every external AI API call must have a bounded timeout - discovered this the hard
// way while testing embeddings integration: a request to NVIDIA's API hung for 5+
// minutes with no response and no error, which meant none of the retry/fallback/
// circuit-breaker logic built earlier could even engage, since none of it runs until
// a call actually fails. An unbounded hang defeats all of that.
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
