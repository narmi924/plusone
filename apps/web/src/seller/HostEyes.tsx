import type { LookDTO } from "@plusone/shared";
import type { LocalVideoTrack } from "livekit-client";
import { useEffect, useState } from "react";
import { api } from "../lib/api";

// Hands-free hosting: while the camera is live, PlusOne looks at a frame every
// couple of seconds. Hold a product up and it goes on screen for buyers, so
// their "+1" means what they can see. Frames are small JPEGs; nothing is kept.

const EVERY_MS = 2_000;

export function WatchControl({
  sessionId,
  token,
  track,
}: {
  sessionId: string;
  token: string;
  track: LocalVideoTrack | null;
}) {
  const [on, setOn] = useState(false);
  const [look, setLook] = useState<Extract<LookDTO, { busy: false }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!on || !track) return;
    let stopped = false;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([track.mediaStreamTrack]);
    void video.play().catch(() => undefined);
    const canvas = document.createElement("canvas");

    void (async () => {
      while (!stopped) {
        const started = Date.now();
        if (video.videoWidth > 0) {
          canvas.width = 512;
          canvas.height = Math.round((video.videoHeight / video.videoWidth) * 512);
          canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
          const frame = canvas.toDataURL("image/jpeg", 0.72).split(",")[1] ?? "";
          try {
            const r = await api.look(sessionId, frame, token);
            if (!stopped && !r.busy) setLook(r);
            setError(null);
          } catch (err) {
            if (!stopped) setError(err instanceof Error ? err.message : String(err));
          }
        }
        await new Promise((r) => setTimeout(r, Math.max(300, EVERY_MS - (Date.now() - started))));
      }
    })();
    return () => {
      stopped = true;
      video.srcObject = null;
    };
  }, [on, track, sessionId, token]);

  const watching = on && Boolean(track);
  return (
    <div
      className={`shrink-0 rounded-[10px] border-2 border-black p-3 ${watching ? "bg-pale" : "bg-label"}`}
    >
      <button
        type="button"
        onClick={() => {
          setOn(!on);
          setLook(null);
        }}
        aria-pressed={on}
        className="w-full text-left text-sm leading-tight font-extrabold"
      >
        {watching ? "Watching your camera" : "Let PlusOne watch"}
      </button>
      <p className="mt-1.5 min-h-9 text-[13px] leading-snug" aria-live="polite">
        {!on ? (
          <span className="text-quiet">
            Hold a product up to the camera and it goes on screen for buyers.
          </span>
        ) : !track ? (
          <span>Turn your camera on first.</span>
        ) : look?.product ? (
          <span>
            {look.onScreen ? "On screen: " : "I see "}
            <b>{look.product.name}</b>
            {look.onScreen ? "" : ", hold it there…"}
          </span>
        ) : look?.saw ? (
          <span className="opacity-70">{look.saw}</span>
        ) : (
          <span className="opacity-70">Hold up the next item.</span>
        )}
      </p>
      {error && <p className="mt-1 text-sm text-pen">{error}</p>}
    </div>
  );
}
