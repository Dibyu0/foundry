import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export const APP_SHELL_CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const HSTS_MAX_AGE = 7 * 24 * 60 * 60; // 7 days, dev-grade

/** Assigns every response an X-Request-Id for log correlation. */
export function requestId(): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Request-Id', randomUUID());
    next();
  };
}

/**
 * Strict baseline headers for the app shell and API. Preview responses
 * override Content-Security-Policy with a site-specific policy.
 */
export function appShellHeaders(): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Content-Security-Policy', APP_SHELL_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Strict-Transport-Security', `max-age=${HSTS_MAX_AGE}`);
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  };
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/** Hard cap on tracked buckets so address rotation can't grow the map. */
const MAX_BUCKETS = 10_000;

/**
 * Bucket key for a request. IPv6 clients trivially rotate source addresses
 * inside their /64 to defeat per-address limiting, so all IPv6 addresses in
 * the same /64 share one bucket (RFC 4941 makes per-address keys useless).
 */
function bucketKey(req: Request): string {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  if (ip.includes(':')) {
    const parts = ip.split(':');
    if (parts.length > 4) return `${parts.slice(0, 4).join(':')}::/64`;
  }
  return ip;
}

/**
 * Fixed-window per-IP limiter. Answers 429 with a Retry-After header once
 * `max` requests inside the current window are exceeded.
 */
export function rateLimit({ windowMs, max }: RateLimitOptions): RequestHandler {
  const buckets = new Map<string, Bucket>();
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
    // Rotation-resistant cap: shed the oldest entries past MAX_BUCKETS.
    if (buckets.size > MAX_BUCKETS) {
      const excess = buckets.size - MAX_BUCKETS;
      let removed = 0;
      for (const key of buckets.keys()) {
        buckets.delete(key);
        removed += 1;
        if (removed >= excess) break;
      }
    }
  }, windowMs);
  sweeper.unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = bucketKey(req);
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'rate limit exceeded', retryAfter });
      return;
    }
    next();
  };
}
