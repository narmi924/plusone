import { type FormEvent, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useLive } from "../lib/useLiveRoom";

// "Ask PlusOne": the seller types (or says) what they want. PlusOne looks
// things up in tonight's orders and in PayPal through PayPal's Agent Toolkit,
// and anything that moves money or messages buyers comes back as a card to
// approve. Steps show as they happen, so the seller sees what was checked.

type Step = { key: number; tool: string; label: string; source: "paypal" | "plusone" };
type Card = {
  id: string;
  title: string;
  source: "paypal" | "plusone";
  state: "open" | "running" | "done" | "dismissed" | "failed";
  result?: string;
};
type Exchange = {
  id: number;
  question: string;
  /** Said out loud by the host rather than typed. */
  voice: boolean;
  steps: Step[];
  cards: Card[];
  images: Array<{ dataUrl: string; caption: string }>;
  answer: string | null;
  error?: string;
};

const SUGGESTIONS = [
  "Who still owes?",
  "Remind everyone who hasn't paid",
  "Any PayPal disputes?",
  "Show the batik shirt",
];

/** Reads a fetch response as server-sent events. */
async function readEvents(res: Response, on: (event: string, data: unknown) => void) {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut = buffer.indexOf("\n\n");
    while (cut >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const event = block.match(/^event: (.+)$/m)?.[1];
      const data = block.match(/^data: (.+)$/m)?.[1];
      if (event) on(event, data ? JSON.parse(data) : null);
      cut = buffer.indexOf("\n\n");
    }
  }
}

export function Copilot({ sessionId, token }: { sessionId: string; token: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const spoken = useLive((s) => s.copilotAsk);
  const askRef = useRef<(q: string, voice?: boolean) => Promise<void>>(async () => undefined);

  const update = (fn: (e: Exchange) => Exchange) =>
    setExchanges((all) => all.map((e, i) => (i === all.length - 1 ? fn(e) : e)));

  // The host said "PlusOne, …" out loud: ask it as if typed.
  useEffect(() => {
    if (spoken) void askRef.current(spoken.text, true);
  }, [spoken]);

  async function ask(question: string, voice = false) {
    if (!question.trim() || busy) return;
    setBusy(true);
    setText("");
    const history = exchanges
      .slice(-3)
      .flatMap((e) => [
        { role: "user" as const, text: e.question },
        ...(e.answer ? [{ role: "assistant" as const, text: e.answer }] : []),
      ]);
    setExchanges((all) => [
      ...all.slice(-2),
      { id: ++seq.current, question, voice, steps: [], cards: [], images: [], answer: null },
    ]);
    try {
      const res = await fetch(`/api/seller/sessions/${sessionId}/copilot`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-seller-token": token },
        body: JSON.stringify({ message: question, history }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(err?.error ?? `The copilot isn't available (${res.status})`);
      }
      await readEvents(res, (event, data) => {
        const d = data as Record<string, string>;
        if (event === "step")
          update((e) => ({
            ...e,
            steps: [...e.steps, { ...(d as unknown as Step), key: ++seq.current }],
          }));
        else if (event === "proposal")
          update((e) => ({
            ...e,
            cards: [...e.cards, { ...(d as unknown as Card), state: "open" }],
          }));
        else if (event === "image")
          update((e) => ({
            ...e,
            images: [...e.images, { dataUrl: d.dataUrl ?? "", caption: d.caption ?? "" }],
          }));
        else if (event === "text") update((e) => ({ ...e, answer: d.text ?? "" }));
        else if (event === "error") update((e) => ({ ...e, error: d.message ?? "" }));
      });
    } catch (err) {
      update((e) => ({ ...e, error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  async function decide(exchange: number, card: Card, approve: boolean) {
    const set = (patch: Partial<Card>) =>
      setExchanges((all) =>
        all.map((e, i) =>
          i === exchange
            ? { ...e, cards: e.cards.map((c) => (c.id === card.id ? { ...c, ...patch } : c)) }
            : e,
        ),
      );
    if (!approve) {
      set({ state: "dismissed" });
      void api.dismissProposal(sessionId, card.id, token).catch(() => undefined);
      return;
    }
    set({ state: "running" });
    try {
      const r = await api.applyProposal(sessionId, card.id, token);
      set({ state: "done", result: r.result });
    } catch (err) {
      set({ state: "failed", result: err instanceof Error ? err.message : String(err) });
    }
  }

  askRef.current = ask;

  function submit(e: FormEvent) {
    e.preventDefault();
    void ask(text);
  }

  const last = exchanges.length - 1;
  return (
    <section className="label mb-4" aria-label="Ask PlusOne">
      <form onSubmit={submit} className="zone flex items-center gap-2 px-3 py-2.5">
        <span className="shrink-0 text-sm font-extrabold">Ask PlusOne</span>
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Who still owes? Refund Farah's skirt. Ship Mei's with Ninja Van NV123…"
          aria-label="Ask PlusOne"
          maxLength={600}
          className="min-w-0 flex-1 rounded-full border-2 border-black bg-label px-3.5 py-1.5 text-sm focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || !text.trim()}
          className="rounded-full bg-black px-4 py-1.5 text-sm font-bold text-white disabled:opacity-40"
        >
          {busy ? "Working…" : "Ask"}
        </button>
      </form>
      {exchanges.length === 0 ? (
        <div className="zone flex flex-wrap items-center gap-2 px-3 py-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => void ask(s)}
              className="rounded-full bg-paper px-3 py-1 text-[13px] font-semibold hover:bg-pale"
            >
              {s}
            </button>
          ))}
          <span className="ml-auto text-xs text-quiet">
            Looks things up in PayPal with PayPal's Agent Toolkit
          </span>
        </div>
      ) : (
        exchanges.map((e, i) =>
          i < last ? (
            <p key={e.id} className="zone truncate px-3.5 py-1.5 text-[13px] text-quiet">
              You: {e.question}
              {e.answer ? `  PlusOne: ${e.answer}` : ""}
            </p>
          ) : (
            <div key={e.id} className="zone max-h-[46vh] overflow-y-auto px-3.5 py-2.5">
              <p className="text-[13px] text-quiet">
                {e.voice ? "You said" : "You"}: {e.question}
              </p>
              {e.steps.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {e.steps.map((s) => (
                    <span
                      key={s.key}
                      className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${s.source === "paypal" ? "bg-black text-white" : "bg-paper"}`}
                    >
                      {s.source === "paypal" ? "PayPal: " : ""}
                      {s.source === "paypal" ? s.label.replace(/^PayPal /, "") : s.label}
                    </span>
                  ))}
                </div>
              )}
              {e.answer === null && !e.error && (
                <p className="mt-1.5 text-sm text-quiet" role="status">
                  Looking…
                </p>
              )}
              {e.answer && <p className="mt-1.5 leading-snug">{e.answer}</p>}
              {e.error && <p className="mt-1.5 text-sm text-pen">{e.error}</p>}
              {e.images.map((img) => (
                <figure key={img.dataUrl.slice(-24)} className="mt-2 inline-block">
                  <img
                    src={img.dataUrl}
                    alt={img.caption}
                    className="h-44 w-44 rounded-lg border-2 border-black"
                  />
                  <figcaption className="text-xs text-quiet">{img.caption}</figcaption>
                </figure>
              ))}
              {e.cards.filter((c) => c.state === "open").length > 1 && (
                <button
                  type="button"
                  onClick={() => {
                    for (const c of e.cards.filter((x) => x.state === "open"))
                      void decide(i, c, true);
                  }}
                  className="mt-2 rounded-full bg-black px-3.5 py-1 text-sm font-bold text-white"
                >
                  Approve all {e.cards.filter((c) => c.state === "open").length}
                </button>
              )}
              {e.cards.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1.5">
                  {e.cards.map((c) => (
                    <li
                      key={c.id}
                      className={`flex flex-wrap items-center gap-2 rounded-label border-2 border-black px-3 py-2 ${c.state === "done" ? "bg-label" : "bg-pale"}`}
                    >
                      <span className="min-w-0 flex-1 text-sm font-bold">
                        {c.source === "paypal" && (
                          <span className="mr-1.5 rounded-full bg-black px-2 py-0.5 text-[11px] text-white">
                            PayPal
                          </span>
                        )}
                        {c.title}
                      </span>
                      {c.state === "open" && (
                        <>
                          <button
                            type="button"
                            onClick={() => void decide(i, c, true)}
                            className="rounded-full bg-black px-3.5 py-1 text-sm font-bold text-white"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            onClick={() => void decide(i, c, false)}
                            className="rounded-full border-2 border-black bg-label px-3 py-1 text-sm font-bold"
                          >
                            Not now
                          </button>
                        </>
                      )}
                      {c.state === "running" && (
                        <span className="text-sm text-quiet">Doing it…</span>
                      )}
                      {c.state === "done" && (
                        <span className="text-sm font-semibold text-paid">✓ {c.result}</span>
                      )}
                      {c.state === "failed" && <span className="text-sm text-pen">{c.result}</span>}
                      {c.state === "dismissed" && (
                        <span className="text-sm text-quiet">Skipped</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ),
        )
      )}
    </section>
  );
}
