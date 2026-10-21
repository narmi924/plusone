import type { ChatMessageDTO } from "@plusone/shared";

// "+1 Aisha, Blue M": who just got what, read from PlusOne's room
// announcements ("Aisha got the last one: Linen Wrap Dress, Blue M").

export interface Claim {
  id: string;
  who: string;
  what: string;
  at: number;
}

export function recentClaims(
  messages: ChatMessageDTO[],
  opts: { limit: number; withinMs?: number; now?: number },
): Claim[] {
  const now = opts.now ?? Date.now();
  const out: Claim[] = [];
  for (let i = messages.length - 1; i >= 0 && out.length < opts.limit; i--) {
    const m = messages[i];
    if (m?.authorKind !== "system") continue;
    const at = new Date(m.createdAt).getTime();
    if (opts.withinMs !== undefined && now - at > opts.withinMs) break;
    const got = m.body.match(/^(.+?) got (?:the last one: )?(.+?)(?: from the waitlist)?$/);
    if (!got?.[1] || !got[2]) continue;
    const parts = got[2].split(", ");
    out.push({
      id: m.id,
      who: got[1],
      what: parts.length > 1 ? (parts.at(-1) ?? got[2]) : got[2],
      at,
    });
  }
  return out;
}

export function ago(at: number, now: number) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}
