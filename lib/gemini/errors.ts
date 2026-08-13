// Structured error classification for AI model calls, so failures can be told
// apart (a dead API key vs. a busy model vs. a transient network blip) instead
// of every failure looking like a generic "metadata generation failed".

export type ErrorCode =
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'MODEL_UNAVAILABLE'
  | 'AUTHENTICATION_FAILED'
  | 'MALFORMED_REQUEST'
  | 'MALFORMED_RESPONSE'
  | 'CONTENT_REFUSED'
  | 'SERVER_ERROR'
  | 'NETWORK_ERROR'
  | 'UNKNOWN';

export interface ClassifiedError {
  code: ErrorCode;
  retryable: boolean;
  message: string;
}

/**
 * Classifies an error from an NVIDIA API call (or a generic network/parse
 * error) into a structured code and a retryable/non-retryable verdict, so
 * callers don't waste retries on errors that will never succeed (bad API key,
 * malformed request) while still retrying genuinely transient ones.
 */
export function classifyError(err: unknown): ClassifiedError {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  // Pattern comes from our own fetch wrapper: `NVIDIA API error ${status}: ${body}`
  const statusMatch = message.match(/NVIDIA API error (\d+)/);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : null;

  if (lower.includes('degraded function cannot be invoked') || lower.includes('function is not deployed')) {
    return { code: 'MODEL_UNAVAILABLE', retryable: false, message };
  }
  if (status === 401 || status === 403 || lower.includes('invalid api key') || lower.includes('unauthorized')) {
    return { code: 'AUTHENTICATION_FAILED', retryable: false, message };
  }
  if (status === 429 || lower.includes('rate limit') || lower.includes('resourceexhausted') || lower.includes('too many requests')) {
    return { code: 'RATE_LIMITED', retryable: true, message };
  }
  if (status === 400 || lower.includes('bad request') || lower.includes('malformed request')) {
    return { code: 'MALFORMED_REQUEST', retryable: false, message };
  }
  if (status !== null && status >= 500) {
    return { code: 'SERVER_ERROR', retryable: true, message };
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('etimedout')) {
    return { code: 'TIMEOUT', retryable: true, message };
  }
  if (lower.includes('econnreset') || lower.includes('econnrefused') || lower.includes('fetch failed') || lower.includes('network')) {
    return { code: 'NETWORK_ERROR', retryable: true, message };
  }
  if (lower.includes('json') || lower.includes('unexpected token') || lower.includes('non-english script')) {
    return { code: 'MALFORMED_RESPONSE', retryable: true, message };
  }
  if (lower.startsWith('i cannot') || lower.startsWith("i can't") || lower.includes('refus')) {
    return { code: 'CONTENT_REFUSED', retryable: true, message };
  }

  return { code: 'UNKNOWN', retryable: true, message };
}
