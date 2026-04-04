/**
 * Workers-compatible in-memory rate limiter.
 * Replaces express-rate-limit — backed by a Map<key, timestamps[]>.
 * Note: state is per-isolate (not globally shared across Workers instances).
 */
export function createRateLimiter(windowMs: number, max: number) {
  const store = new Map<string, number[]>();

  return function check(key: string): boolean {
    const now = Date.now();
    const timestamps = store.get(key) ?? [];
    const recent = timestamps.filter((t) => now - t < windowMs);
    if (recent.length >= max) return false;
    recent.push(now);
    store.set(key, recent);
    return true;
  };
}
