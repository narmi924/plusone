import {
  createLocalTracks,
  type LocalTrack,
  type LocalVideoTrack,
  type RemoteAudioTrack,
  type RemoteVideoTrack,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
} from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

// Live video through LiveKit. Viewers join the room only while the host's
// camera is on; the host publishes camera and microphone from the console.

const isHost = (identity: string) => identity.startsWith("host-");

/** Watch the host. Returns their tracks once they arrive. */
export function useWatchLive(sessionId: string | null, hostVideoOn: boolean) {
  const [video, setVideo] = useState<RemoteVideoTrack | null>(null);
  const [audio, setAudio] = useState<RemoteAudioTrack | null>(null);
  const [viewers, setViewers] = useState(0);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const roomRef = useRef<Room | null>(null);

  useEffect(() => {
    if (!sessionId || !hostVideoOn) {
      setVideo(null);
      setAudio(null);
      return;
    }
    let cancelled = false;
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;

    const refresh = () => {
      const host = [...room.remoteParticipants.values()].find((p) => isHost(p.identity));
      setVideo((host?.getTrackPublication(Track.Source.Camera)?.track as RemoteVideoTrack) ?? null);
      setAudio(
        (host?.getTrackPublication(Track.Source.Microphone)?.track as RemoteAudioTrack) ?? null,
      );
      setViewers(
        [...room.remoteParticipants.values()].filter((p) => !isHost(p.identity)).length + 1,
      );
      setSoundBlocked(!room.canPlaybackAudio);
    };
    room
      .on(RoomEvent.TrackSubscribed, refresh)
      .on(RoomEvent.TrackUnsubscribed, refresh)
      .on(RoomEvent.ParticipantConnected, refresh)
      .on(RoomEvent.ParticipantDisconnected, refresh)
      .on(RoomEvent.AudioPlaybackStatusChanged, refresh)
      .on(RoomEvent.Reconnected, refresh);

    api
      .videoToken(sessionId)
      .then(({ url, token }) => (cancelled ? undefined : room.connect(url, token)))
      .then(() => !cancelled && refresh())
      .catch(() => {
        // No video: the stage falls back to the product card.
      });

    return () => {
      cancelled = true;
      roomRef.current = null;
      void room.disconnect();
    };
  }, [sessionId, hostVideoOn]);

  const enableSound = useCallback(() => {
    void roomRef.current?.startAudio().then(() => setSoundBlocked(false));
  }, []);

  return { video, audio, viewers, soundBlocked, enableSound };
}

type HostState = "off" | "starting" | "live" | "error";

/** The seller's camera: preview, publish, stop. */
export function useHostCamera(sessionId: string | null, sellerToken: string) {
  const [state, setState] = useState<HostState>("off");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<LocalVideoTrack | null>(null);
  // The microphone being sent to viewers; speech-to-text listens to the same one.
  const [mic, setMic] = useState<MediaStreamTrack | null>(null);
  const [viewers, setViewers] = useState(0);
  const roomRef = useRef<Room | null>(null);
  const tracksRef = useRef<LocalTrack[]>([]);

  const stop = useCallback(async () => {
    for (const t of tracksRef.current) t.stop();
    tracksRef.current = [];
    setPreview(null);
    setMic(null);
    await roomRef.current?.disconnect();
    roomRef.current = null;
    setState("off");
    if (sessionId) await api.setVideo(sessionId, false, sellerToken).catch(() => undefined);
  }, [sessionId, sellerToken]);

  const start = useCallback(async () => {
    if (!sessionId) return;
    setState("starting");
    setError(null);
    try {
      const tracks = await createLocalTracks({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: { resolution: VideoPresets.h720.resolution, facingMode: "user" },
      });
      tracksRef.current = tracks;
      setPreview((tracks.find((t) => t.kind === Track.Kind.Video) as LocalVideoTrack) ?? null);
      setMic(tracks.find((t) => t.kind === Track.Kind.Audio)?.mediaStreamTrack ?? null);

      const room = new Room({ dynacast: true });
      roomRef.current = room;
      const count = () => setViewers(room.remoteParticipants.size);
      room.on(RoomEvent.ParticipantConnected, count).on(RoomEvent.ParticipantDisconnected, count);

      const { url, token } = await api.videoToken(sessionId, sellerToken);
      await room.connect(url, token);
      for (const t of tracks) await room.localParticipant.publishTrack(t);
      count();
      await api.setVideo(sessionId, true, sellerToken);
      setState("live");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await stop();
      setState("error");
    }
  }, [sessionId, sellerToken, stop]);

  useEffect(
    () => () => {
      for (const t of tracksRef.current) t.stop();
      void roomRef.current?.disconnect();
    },
    [],
  );

  return { state, error, preview, mic, viewers, start, stop };
}

/** Renders a LiveKit video track. */
export function TrackVideo({
  track,
  mirror = false,
  className = "",
}: {
  track: RemoteVideoTrack | LocalVideoTrack;
  mirror?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className={`${className} ${mirror ? "-scale-x-100" : ""}`}
    />
  );
}

/** Plays the host's microphone. */
export function TrackAudio({ track }: { track: RemoteAudioTrack }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  // biome-ignore lint/a11y/useMediaCaption: live audio has no caption track
  return <audio ref={ref} autoPlay />;
}
