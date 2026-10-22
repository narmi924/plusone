// Sliding-window counters kept in memory. They stop a script or a stuck key
// from running up the AI bill on the public demo (where the seller password is
// on the login page); they don't need to be exact.

export function rateLimit(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5_000)
      for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    return true;
  };
}

/** Per-visitor limits everywhere, plus a whole-site AI budget on the public demo. */
export function createGuards(demo: boolean) {
  const always = () => true;
  return {
    /** Joining the chat, per IP. */
    join: rateLimit(10, 10 * 60_000),
    /** Chat messages, per IP (each one is read by Claude). */
    chat: rateLimit(20, 60_000),
    /** Ask PlusOne and the report assistant, per IP. */
    ask: rateLimit(20, 10 * 60_000),
    /** Camera frames, per IP (one every two seconds while watching). */
    look: rateLimit(45, 60_000),
    /** Claude calls for chat and questions across the whole demo, per hour. */
    ai: demo ? rateLimit(900, 60 * 60_000) : always,
    /** Camera frames across the whole demo, per hour. */
    vision: demo ? rateLimit(600, 60 * 60_000) : always,
  };
}

export type Guards = ReturnType<typeof createGuards>;

/** The visitor's address, behind Render's proxy or not. */
export function clientIp(headers: Record<string, string | string[] | undefined>, fallback: string) {
  const forwarded = headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || fallback;
}
