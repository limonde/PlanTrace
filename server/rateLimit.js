/**
 * Tiny fixed-window rate limiter (in-memory, per process).
 * Good enough for a single-instance personal deployment.
 */

const buckets = new Map(); // key -> { count, resetAt }
let lastCleanup = Date.now();

function cleanup(now) {
  if (now - lastCleanup < 60000) return;
  lastCleanup = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export function rateLimit(key, { limit, windowMs }) {
  const now = Date.now();
  cleanup(now);

  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;

  if (bucket.count > limit) {
    return { allowed: false, retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  return { allowed: true, remaining: limit - bucket.count };
}

/** Client IP, honoring X-Forwarded-For only when PLANTRACE_TRUST_PROXY=1. */
export function clientIp(req) {
  if (process.env.PLANTRACE_TRUST_PROXY === '1') {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket?.remoteAddress || 'unknown';
}

export function isLoopback(req) {
  const ip = req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}
