import type { NextFunction, Request, Response } from "express";

interface RateLimitOptions {
  max: number;
  windowMs: number;
}

export function createRateLimit({ max, windowMs }: RateLimitOptions) {
  const entries = new Map<string, { count: number; resetAt: number }>();
  const cleanup = setInterval(
    () => {
      const now = Date.now();
      for (const [key, entry] of entries)
        if (entry.resetAt <= now) entries.delete(key);
    },
    Math.min(windowMs, 5 * 60_000),
  );
  cleanup.unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const token = req.headers.authorization?.slice(-32) ?? "anonymous";
    const key = `${req.ip}:${token}`;
    const now = Date.now();
    const current = entries.get(key);
    const entry =
      !current || current.resetAt <= now
        ? { count: 1, resetAt: now + windowMs }
        : { ...current, count: current.count + 1 };
    entries.set(key, entry);
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader(
      "X-RateLimit-Remaining",
      String(Math.max(0, max - entry.count)),
    );
    if (entry.count > max) {
      res.setHeader(
        "Retry-After",
        String(Math.ceil((entry.resetAt - now) / 1000)),
      );
      res
        .status(429)
        .json({ error: "Too many requests. Please try again shortly." });
      return;
    }
    next();
  };
}
