import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ReplayClip } from "@plusone/shared";

// Replay: on the public demo, when nobody is hosting, the stage plays recorded
// clips of a host showing the drop, and whatever the clip shows is what's on
// screen for "+1". The schedule runs on the wall clock, so every viewer sees
// the same clip at the same moment, like a real live.

const candidates = [
  // Built web app (production) and the source folder (dev).
  new URL("../../../web/dist/replay/replay.json", import.meta.url),
  new URL("../../../web/public/replay/replay.json", import.meta.url),
];

/** The clips listed in replay/replay.json, or null when there are none. */
export function loadReplay(): ReplayClip[] | null {
  for (const url of candidates) {
    const path = fileURLToPath(url);
    if (!existsSync(path)) continue;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { clips?: ReplayClip[] };
    const clips = (parsed.clips ?? []).filter((c) => c.src && c.product && c.seconds > 0);
    return clips.length > 0 ? clips : null;
  }
  return null;
}

/** Which clip plays at this moment, and how far into it. */
export function clipAt(clips: ReplayClip[], nowMs: number) {
  const total = clips.reduce((n, c) => n + c.seconds, 0);
  let t = (nowMs / 1000) % total;
  for (const [index, clip] of clips.entries()) {
    if (t < clip.seconds) return { index, clip, offset: t };
    t -= clip.seconds;
  }
  // Floating point at the very end of the loop: the first clip again.
  const first = clips[0] as ReplayClip;
  return { index: 0, clip: first, offset: 0 };
}
