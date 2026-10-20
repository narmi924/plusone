import type { ChatMessageDTO } from "@plusone/shared";
import { type FormEvent, useEffect, useRef, useState } from "react";

// Two ways to show the same chat. Over the video for buyers, the way live apps
// do it: white names and lines, PlusOne's private replies as white bubbles.
// As a plain column for the seller, with PlusOne's replies in blue ink.

export function ChatFeed({
  messages,
  thinking,
  myBuyerId,
  variant,
  onOption,
}: {
  messages: ChatMessageDTO[];
  thinking: Set<string>;
  myBuyerId: string | null;
  variant: "overlay" | "panel";
  onOption?: ((say: string) => void) | undefined;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const last = messages.at(-1)?.id;
  // The seller's column scrolls to the newest line; the overlay is pinned to the bottom already.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when a new message lands
  useEffect(() => {
    if (variant === "panel") endRef.current?.scrollIntoView({ block: "end" });
  }, [last, thinking.size]);

  const names = new Map(
    messages.filter((m) => m.authorKind === "buyer").map((m) => [m.buyerId, m.authorName]),
  );
  const overlay = variant === "overlay";

  return (
    <ol className={`flex flex-col ${overlay ? "gap-1.5" : "gap-2.5"}`} aria-live="polite">
      {messages.map((m) => {
        if (m.authorKind === "assistant") {
          if (overlay) {
            return (
              <li key={m.id} className="max-w-136 rounded-xl bg-paper px-3 py-2 text-black">
                <div className="text-xs text-quiet">PlusOne, only you see this</div>
                <p className="text-[15px] leading-snug">{m.body}</p>
                {m.options && m.options.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {m.options.map((o) => (
                      <button
                        key={o.say}
                        type="button"
                        disabled={!onOption}
                        onClick={() => onOption?.(o.say)}
                        className="rounded-full bg-sticker px-3 py-1.5 text-[13px] font-bold enabled:active:scale-95 disabled:opacity-60"
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            );
          }
          const to = m.buyerId ? names.get(m.buyerId) : null;
          return (
            <li key={m.id} className="border-l-[3px] border-ink py-0.5 pl-2.5 text-ink">
              <div className="text-xs text-quiet">{to ? `to ${to}` : "PlusOne"}</div>
              <p className="leading-snug">{m.body}</p>
            </li>
          );
        }

        if (m.authorKind === "system") {
          return (
            <li key={m.id} className={overlay ? "over-video font-bold text-sticker" : "font-bold"}>
              {!overlay && <span className="mr-1 text-pen">+1</span>}
              {m.body}
            </li>
          );
        }

        const mine = m.buyerId !== null && m.buyerId === myBuyerId;
        return (
          <li key={m.id} className={`leading-snug ${overlay ? "over-video text-[15px]" : ""}`}>
            <span className="mr-1.5 font-bold">
              {m.authorName}
              {mine && (
                <span className={`ml-1 font-normal ${overlay ? "text-white/70" : "text-quiet"}`}>
                  (you)
                </span>
              )}
            </span>
            <span className="break-words">{m.body}</span>
            {thinking.has(m.id) && (mine || !overlay) && <Reading overlay={overlay} />}
          </li>
        );
      })}
      <div ref={endRef} />
    </ol>
  );
}

function Reading({ overlay }: { overlay: boolean }) {
  return (
    <span
      className={`ml-2 inline-flex items-center gap-1 align-middle text-xs ${overlay ? "text-sticker" : "text-ink"}`}
      role="status"
    >
      <span className="inline-flex gap-0.5">
        <span className="h-1 w-1 animate-pulse rounded-full bg-current" />
        <span className="h-1 w-1 animate-pulse rounded-full bg-current [animation-delay:150ms]" />
        <span className="h-1 w-1 animate-pulse rounded-full bg-current [animation-delay:300ms]" />
      </span>
      reading
    </span>
  );
}

/** The bar at the bottom of the stage: type anything, or tap the big +1. */
export function ChatInput({ onSend }: { onSend: (body: string) => Promise<unknown> }) {
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function send(text: string) {
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(text);
      setBody("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void send(body.trim());
  }

  return (
    <form onSubmit={submit}>
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full bg-white/95 py-1.5 pr-1.5 pl-4 text-black">
          <input
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Say +1, ask about sizes, anything"
            maxLength={500}
            aria-label="Chat message"
            className="min-w-0 flex-1 bg-transparent py-1.5 text-[15px] placeholder:text-quiet focus:outline-none"
          />
          <button
            type="submit"
            disabled={!body.trim() || sending}
            className="rounded-full bg-black px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40"
          >
            Send
          </button>
        </div>
        <button
          type="button"
          onClick={() => void send("+1")}
          disabled={sending}
          aria-label="Say +1"
          className="price-type h-14 w-14 shrink-0 rounded-full bg-sticker text-xl text-pen shadow-[0_6px_18px_rgb(0_0_0/0.35)] active:scale-95 disabled:opacity-60"
        >
          +1
        </button>
      </div>
      {error && <p className="over-video mt-2 text-sm font-semibold text-sticker">{error}</p>}
    </form>
  );
}
