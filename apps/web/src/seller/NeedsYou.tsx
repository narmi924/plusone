import { type AttentionDTO, formatMoney } from "@plusone/shared";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useLive } from "../lib/useLiveRoom";

// What only the seller can decide, written in red pen at the top of the book.
// Everything else PlusOne handles in the chat, so this is usually empty or one
// line long. Money only goes back when the seller presses Refund.

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
    <section aria-label="Needs you" className="mb-(--rule-h) text-pen">
      <h2 className="sr-only">Needs you</h2>
      <ul>
        {items.map((item) => (
          <li key={item.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
            <p className="font-hand text-xl leading-(--rule-h)">
              {item.buyerName && <b className="mr-1.5">{item.buyerName}</b>}
              <span className="mr-2 text-base opacity-80">
                {KIND_LABEL[item.kind] ?? item.kind}:
              </span>
              {item.summary.replace(/^[^:]+:\s*/, "")}
            </p>
            <div className="flex gap-2">
              {item.refund && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() =>
                    act(item.id, () => api.refundLine(item.refund?.lineId ?? "", token))
                  }
                  className="rounded-full border-[1.5px] border-pen bg-white px-3 py-1.5 text-[13px] font-bold disabled:opacity-50"
                >
                  {busy === item.id
                    ? "Refunding…"
                    : `Refund ${formatMoney(item.refund.amountCents, item.refund.currency)} with PayPal`}
                </button>
              )}
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => act(item.id, () => api.resolveAttention(item.id, token))}
                className="rounded-full border-[1.5px] border-pen bg-white px-3 py-1.5 text-[13px] font-bold disabled:opacity-50"
              >
                Done
              </button>
            </div>
          </li>
        ))}
      </ul>
      {error && <p className="font-hand text-lg">{error}</p>}
    </section>
  );
}
