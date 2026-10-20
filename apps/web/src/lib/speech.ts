import { useCallback, useEffect, useRef, useState } from "react";

// The host's microphone, streamed to the server over the console's live
// connection. The server runs speech-to-text (the speech key stays there) and
// sends back what it hears; finished sentences go to PlusOne, which decides
// whether they announced anything.

export const HOST_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "zh", label: "中文" },
  { code: "ms", label: "Bahasa Melayu" },
] as const;
export type HostLanguage = (typeof HOST_LANGUAGES)[number]["code"];

type State = "off" | "starting" | "on" | "error";

export function useHostSpeech(
  link: {
    hostListen: (language: string, on: boolean) => Promise<boolean>;
    hostAudio: (chunk: ArrayBuffer) => void;
  },
  liveMic: MediaStreamTrack | null,
) {
  const [state, setState] = useState<State>("off");
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const ownStreamRef = useRef<MediaStream | null>(null);
  const { hostListen, hostAudio } = link;

  const release = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    recorderRef.current = null;
    for (const t of ownStreamRef.current?.getTracks() ?? []) t.stop();
    ownStreamRef.current = null;
  }, []);

  const stop = useCallback(async () => {
    release();
    setState("off");
    await hostListen("en", false).catch(() => undefined);
  }, [release, hostListen]);

  const start = useCallback(
    async (language: HostLanguage) => {
      setState("starting");
      setError(null);
      try {
        // Reuse the microphone already going out to viewers, if the camera is on.
        let stream: MediaStream;
        if (liveMic && liveMic.readyState === "live") {
          stream = new MediaStream([liveMic]);
        } else {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
          });
          ownStreamRef.current = stream;
        }
        await hostListen(language, true);
        const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
        recorderRef.current = recorder;
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) void e.data.arrayBuffer().then(hostAudio);
        };
        recorder.start(250);
        setState("on");
      } catch (err) {
        release();
        setError(err instanceof Error ? err.message : String(err));
        setState("error");
      }
    },
    [liveMic, hostListen, hostAudio, release],
  );

  // Leaving the console stops listening.
  useEffect(() => release, [release]);

  return { state, error, start, stop };
}
