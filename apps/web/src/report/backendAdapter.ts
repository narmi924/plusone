import type {
  AgAiEvent,
  AgLlmAdapter,
  AgLlmRequest,
  AgLlmResponse,
  AgLlmResponseHandler,
} from "ag-studio";

// AG Studio's agents talk to Claude through our server (the API key stays
// there). Each turn: POST the Studio request, read back server-sent events:
// `ag` (stream events for the chat panel), then `complete` (the full response
// Studio acts on) or `error`.

export function backendAdapter(
  endpoint: string,
  headers: () => Record<string, string>,
): AgLlmAdapter {
  return {
    executeTurn(request: AgLlmRequest, options?: { signal?: AbortSignal }): AgLlmResponseHandler {
      let resolve!: (r: AgLlmResponse) => void;
      let reject!: (e: Error) => void;
      const complete = new Promise<AgLlmResponse>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // An abandoned stream must not raise an unhandled rejection.
      void complete.catch(() => undefined);

      async function* events(): AsyncGenerator<AgAiEvent> {
        let final: AgLlmResponse | undefined;
        let failure: Error | undefined;
        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "text/event-stream",
              ...headers(),
            },
            body: JSON.stringify(request),
            signal: options?.signal ?? null,
          });
          if (!res.ok || !res.body) throw new Error(`Assistant unavailable (HTTP ${res.status})`);
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += value;
            const frames = buf.split("\n\n");
            buf = frames.pop() ?? "";
            for (const frame of frames) {
              const type = /^event: (.+)$/m.exec(frame)?.[1];
              const data = /^data: (.*)$/m.exec(frame)?.[1];
              if (!type || data == null) continue;
              const payload = JSON.parse(data);
              if (type === "ag") yield payload as AgAiEvent;
              else if (type === "complete") final = payload as AgLlmResponse;
              else if (type === "error")
                failure = new Error((payload as { message: string }).message);
            }
          }
        } catch (e) {
          failure = e instanceof Error ? e : new Error(String(e));
        }
        if (failure) reject(failure);
        else if (final) resolve(final);
        else reject(new Error("The assistant stopped without an answer"));
      }

      const it = events();
      return { stream: { [Symbol.asyncIterator]: () => it }, complete };
    },
  };
}
