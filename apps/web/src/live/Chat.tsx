import type { ChatMessageDTO, ProductDTO } from "@plusone/shared";
import { type FormEvent, useEffect, useRef, useState } from "react";

// Two ways to show the same chat. Over the video for buyers, the way live apps
// do it: white names and lines, PlusOne's private replies as white bubbles.
// As a plain column for the seller, with PlusOne's replies in soft bubbles.

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
  // Choices stay tappable only on the question still waiting for an answer:
  // once the buyer has said something after it, they go away.
  const lastMine = messages.findLastIndex(
    (m) => m.authorKind === "buyer" && m.buyerId !== null && m.buyerId === myBuyerId,
  );
  const openQuestion = messages.findLastIndex((m) => Boolean(m.options?.length));
  const answerable = openQuestion > lastMine ? messages[openQuestion]?.id : undefined;

  return (
    <ol className={`flex flex-col ${overlay ? "gap-1.5" : "gap-2.5"}`} aria-live="polite">
      {messages.map((m) => {
        if (m.authorKind === "assistant") {
          if (overlay) {
            return (
              <li
                key={m.id}
                className="max-w-136 rounded-2xl bg-label px-3.5 py-2.5 text-black"
                title="From PlusOne, only you see this"
              >
                <p className="text-[15px] leading-snug">{m.body}</p>
                {m.options && m.options.length > 0 && m.id === answerable && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {m.options.map((o) => (
                      <button
                        key={o.say}
                        type="button"
                        disabled={!onOption}
                        onClick={() => onOption?.(o.say)}
                        className="rounded-full border-2 border-black bg-sticker px-3 py-1.5 text-[13px] font-bold enabled:active:scale-95 disabled:opacity-60"
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
            <li key={m.id} className="rounded-xl bg-paper px-3 py-2">
              <div className="text-xs text-quiet">{to ? `PlusOne to ${to}` : "PlusOne"}</div>
              <p className="leading-snug">{m.body}</p>
            </li>
          );
        }

        if (m.authorKind === "host" && m.visibility === "private") {
          return overlay ? (
            <li key={m.id} className="max-w-136 rounded-2xl bg-label px-3.5 py-2.5 text-black">
              <div className="text-xs font-bold">{m.authorName}</div>
              <p className="text-[15px] leading-snug">{m.body}</p>
            </li>
          ) : (
            <li key={m.id} className="rounded-xl bg-pale px-3 py-2">
              <div className="text-xs text-quiet">
                You to {m.buyerId ? names.get(m.buyerId) : "a buyer"}
              </div>
              <p className="leading-snug">{m.body}</p>
            </li>
          );
        }

        if (m.authorKind === "system") {
          return (
            <li
              key={m.id}
              className={
                overlay
                  ? "over-video text-[15px] font-bold"
                  : "self-start rounded-md bg-pale px-2 py-0.5 font-bold"
              }
            >
              <span className={`mr-1 ${overlay ? "text-sticker" : "text-pen"}`}>+1</span>
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
      className={`ml-2 inline-flex items-center gap-1 align-middle text-xs ${overlay ? "text-sticker" : "text-quiet"}`}
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

/** Things to try for what's on screen, the way buyers actually type them. */
export function tryLines(current: ProductDTO | null, previous: ProductDTO | null) {
  const inStock = (p: ProductDTO) => p.variants.filter((v) => v.available > 0);
  const option = (v: ProductDTO["variants"][number]) =>
    [v.color?.toLowerCase(), v.size].filter(Boolean).join(" ");
  const lines: string[] = [];
  const now = current ? inStock(current) : [];
  const first = now[0];
  lines.push(first && option(first) ? `+1 ${option(first)}` : "+1");
  const before = previous ? inStock(previous)[0] : undefined;
  if (previous && before) {
    const noun = previous.name.split(" ").at(-1)?.toLowerCase() ?? "one";
    lines.push(option(before) ? `the ${noun} just now, ${option(before)}` : `the ${noun} just now`);
  }
  const other = now.find((v) => v.color && v.color !== first?.color);
  lines.push(other?.color ? `change it to ${other.color.toLowerCase()}` : "make it 2");
  lines.push("cancel that");
  return lines;
}

/** The bar at the bottom of the stage: type anything, or tap the big +1. */
export function ChatInput({
  onSend,
  draft,
  placeholder = "Say +1, or ask anything",
}: {
  onSend: (body: string) => Promise<unknown>;
  /** Text to put in the box (from a tapped suggestion); `n` makes repeats count. */
  draft?: { text: string; n: number } | null;
  /** What to try for what's on screen, e.g. 'Say +1, or "the dress just now, blue S"'. */
  placeholder?: string;
}) {
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!draft) return;
    setBody(draft.text);
    inputRef.current?.focus();
  }, [draft]);

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
            ref={inputRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={placeholder}
            maxLength={500}
            aria-label="Chat message"
            className="min-w-0 flex-1 bg-transparent py-1.5 text-[15px] placeholder:text-quiet focus:outline-none"
          />
          {body.trim() && (
            <button
              type="submit"
              disabled={sending}
              className="rounded-full bg-black px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40"
            >
              Send
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => void send("+1")}
          disabled={sending}
          aria-label="Say +1"
          className="h-14 w-14 shrink-0 rounded-full border-2 border-black bg-sticker text-[22px] font-black text-black [font-stretch:75%] shadow-[0_6px_18px_rgb(0_0_0/0.35)] active:scale-95 disabled:opacity-60"
        >
          +1
        </button>
      </div>
      {error && <p className="over-video mt-2 text-sm font-semibold text-sticker">{error}</p>}
    </form>
  );
}
