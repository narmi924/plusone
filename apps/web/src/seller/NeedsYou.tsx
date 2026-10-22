import { type AttentionDTO, formatMoney } from "@plusone/shared";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useLive } from "../lib/useLiveRoom";

// What only the seller can decide, on red and white packing tape across the
// top of the table. Everything else PlusOne handles in the chat, so this is
// usually empty or one strip long. Money only goes back when the seller
// presses Refund.

const KIND_LABEL: Record<string, string> = {
  question: "asks",
  cancel_paid: "wants to cancel, already paid",
  change_paid: "wants to change, already paid",
  change_not_held: "wants to change after the hold ended",
  not_understood: "PlusOne couldn't read this",
  partly_sold_out: "part of the order sold out",
  paid_but_gone: "paid, but the item was gone",
};

export function NeedsYou({ sessionId, token }: { sessionId: string; token: string }) {
  const version = useLive((s) => s.attentionVersion);
  const [items, setItems] = useState<AttentionDTO[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replying, setReplying] = useState<string | null>(null);
  const [text, setText] = useState("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: version is the refetch signal
  useEffect(() => {
    api.attention(sessionId, token).then(setItems, () => undefined);
  }, [sessionId, token, version]);

  async function act(id: string, run: () => Promise<unknown>) {
    setBusy(id);
    setError(null);
    try {
      await run();
      setItems(await api.attention(sessionId, token));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0 && !error) return null;
  return (
    <section aria-label="Needs you" className="mb-3 flex flex-col gap-2.5">
      <h2 className="sr-only">Needs you</h2>
      {items.map((item) => (
        <div key={item.id} className="tape">
          <div className="flex flex-wrap items-center gap-3 rounded-[3px] bg-label px-3 py-2.5">
            <p className="min-w-0 flex-1 text-[15px] leading-snug">
              <b className="mr-1 font-extrabold">
                {item.buyerName} {KIND_LABEL[item.kind] ?? item.kind}:
              </b>
              {item.summary.replace(/^[^:]+:\s*/, "")}
            </p>
            {item.refund && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => act(item.id, () => api.refundLine(item.refund?.lineId ?? "", token))}
                className="rounded-full border-2 border-black bg-black px-3.5 py-1.5 text-[13px] font-bold text-white disabled:opacity-50"
              >
                {busy === item.id
                  ? "Refunding…"
                  : `Refund ${formatMoney(item.refund.amountCents, item.refund.currency)} with PayPal`}
              </button>
            )}
            {item.canReply && !item.refund && replying !== item.id && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  setReplying(item.id);
                  setText("");
                }}
                className="rounded-full border-2 border-black bg-black px-3.5 py-1.5 text-[13px] font-bold text-white disabled:opacity-50"
              >
                Reply
              </button>
            )}
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => act(item.id, () => api.resolveAttention(item.id, token))}
              className="rounded-full border-2 border-black bg-label px-3.5 py-1.5 text-[13px] font-bold disabled:opacity-50"
            >
              Done
            </button>
          </div>
          {replying === item.id && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!text.trim()) return;
                void act(item.id, () => api.replyAttention(item.id, text, token)).then(() =>
                  setReplying(null),
                );
              }}
              className="mt-1.5 flex items-center gap-2 rounded-[3px] bg-label px-3 py-2"
            >
              <input
                // biome-ignore lint/a11y/noAutofocus: the seller just asked to reply
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={`Reply to ${item.buyerName ?? "them"}, only they see it`}
                aria-label="Reply"
                maxLength={500}
                className="min-w-0 flex-1 rounded-full border-2 border-black px-3.5 py-1.5 text-sm focus:outline-none"
              />
              <button
                type="submit"
                disabled={busy !== null || !text.trim()}
                className="rounded-full bg-black px-4 py-1.5 text-sm font-bold text-white disabled:opacity-40"
              >
                Send
              </button>
            </form>
          )}
        </div>
      ))}
      {error && <p className="rounded-[10px] bg-label px-3 py-2 text-sm text-pen">{error}</p>}
    </section>
  );
}
