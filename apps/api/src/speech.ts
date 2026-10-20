import type { FastifyBaseLogger } from "fastify";

// The host's microphone audio arrives from the console over Socket.IO and is
// relayed to Deepgram's streaming speech-to-text from here, so the Deepgram key
// never reaches a browser. Finished sentences go to PlusOne; partial ones are
// shown to the host as they speak.

interface DeepgramMessage {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: Array<{ transcript?: string }> };
}

interface Stream {
  ws: WebSocket;
  queue: Array<ArrayBuffer | Uint8Array>;
  finals: string[];
  keepAlive: ReturnType<typeof setInterval>;
}

export function createSpeechRelay(deps: {
  apiKey: string;
  log: FastifyBaseLogger;
  onInterim: (sessionId: string, text: string) => void;
  onSentence: (sessionId: string, text: string) => void;
}) {
  const streams = new Map<string, Stream>();

  function flush(sessionId: string, stream: Stream) {
    const text = stream.finals.join(" ").trim();
    stream.finals = [];
    deps.onInterim(sessionId, "");
    if (text) deps.onSentence(sessionId, text);
  }

  function stop(sessionId: string) {
    const stream = streams.get(sessionId);
    if (!stream) return;
    streams.delete(sessionId);
    clearInterval(stream.keepAlive);
    flush(sessionId, stream);
    if (stream.ws.readyState === WebSocket.OPEN)
      stream.ws.send(JSON.stringify({ type: "CloseStream" }));
    stream.ws.close();
  }

  function start(sessionId: string, language: string) {
    stop(sessionId);
    const params = new URLSearchParams({
      model: "nova-3",
      language,
      smart_format: "true",
      interim_results: "true",
      endpointing: "400",
      utterance_end_ms: "1500",
    });
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ["token", deps.apiKey]);
    ws.binaryType = "arraybuffer";
    const stream: Stream = {
      ws,
      queue: [],
      finals: [],
      // Deepgram closes a quiet stream after ~10 s; the host may pause longer.
      keepAlive: setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "KeepAlive" }));
      }, 8_000),
    };
    streams.set(sessionId, stream);

    ws.addEventListener("open", () => {
      for (const chunk of stream.queue) ws.send(chunk);
      stream.queue = [];
    });
    ws.addEventListener("message", (event) => {
      let msg: DeepgramMessage;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.type === "UtteranceEnd") return flush(sessionId, stream);
      if (msg.type !== "Results") return;
      const text = msg.channel?.alternatives?.[0]?.transcript?.trim() ?? "";
      if (msg.is_final) {
        if (text) stream.finals.push(text);
        if (msg.speech_final) flush(sessionId, stream);
        else deps.onInterim(sessionId, stream.finals.join(" "));
      } else if (text) {
        deps.onInterim(sessionId, [...stream.finals, text].join(" "));
      }
    });
    ws.addEventListener("error", () => deps.log.warn({ sessionId }, "speech stream error"));
    ws.addEventListener("close", (event) => {
      if (streams.get(sessionId)?.ws === ws) {
        deps.log.info({ sessionId, code: event.code }, "speech stream closed");
        stop(sessionId);
      }
    });
  }

  return {
    start,
    stop,
    isOn: (sessionId: string) => streams.has(sessionId),
    push(sessionId: string, chunk: ArrayBuffer | Uint8Array) {
      const stream = streams.get(sessionId);
      if (!stream) return;
      if (stream.ws.readyState === WebSocket.OPEN) stream.ws.send(chunk);
      else if (stream.ws.readyState === WebSocket.CONNECTING && stream.queue.length < 200)
        stream.queue.push(chunk);
    },
  };
}

export type SpeechRelay = ReturnType<typeof createSpeechRelay>;
