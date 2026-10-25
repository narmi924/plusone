import type { ReplayClip } from "@plusone/shared";
import { useEffect, useRef, useState } from "react";

// The recorded host, played when nobody is hosting (public demo). Which clip
// plays, and from where, comes from the server's clock, so every viewer is at
// the same moment and the product on screen matches what the host shows.

function clipAt(clips: ReplayClip[], nowMs: number) {
  const total = clips.reduce((n, c) => n + c.seconds, 0);
  let t = (nowMs / 1000) % total;
  for (const [index, clip] of clips.entries()) {
    if (t < clip.seconds) return { index, offset: t };
    t -= clip.seconds;
  }
  return { index: 0, offset: 0 };
}

/** A slot can be longer than its clip; the clip loops inside it. */
function within(el: HTMLVideoElement, offset: number) {
  return el.duration > 0 ? offset % el.duration : offset;
}

export function ReplayVideo({
  clips,
  skewMs,
  className = "",
}: {
  clips: ReplayClip[];
  /** Server clock minus this browser's clock. */
  skewMs: number;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [index, setIndex] = useState(() => clipAt(clips, Date.now() + skewMs).index);
  const clip = clips[index] ?? clips[0];

  // Keep to the schedule, checked often so the clip changes with the price label: jump when
  // the clip should change or drifts by more than a second, and start it again if it stopped
  // (it can end before its slot does).
  useEffect(() => {
    const t = setInterval(() => {
      const now = clipAt(clips, Date.now() + skewMs);
      const el = ref.current;
      if (now.index !== index) {
        setIndex(now.index);
        return;
      }
      if (!el) return;
      const want = within(el, now.offset);
      if (Math.abs(el.currentTime - want) > 1.2) el.currentTime = want;
      if (el.paused) el.play().catch(() => {});
    }, 250);
    return () => clearInterval(t);
  }, [clips, skewMs, index]);

  if (!clip) return null;
  return (
    <video
      ref={ref}
      key={clip.src}
      src={clip.src}
      muted
      playsInline
      autoPlay
      loop
      preload="auto"
      onLoadedMetadata={(e) => {
        const el = e.currentTarget;
        el.currentTime = within(el, clipAt(clips, Date.now() + skewMs).offset);
      }}
      className={className}
    />
  );
}
