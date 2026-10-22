import { formatMoney, type OrderDTO, type WalletDTO } from "@plusone/shared";
import { useEffect, useState } from "react";
import { api } from "../lib/api";

// The buyer's saved PayPal. Saved once at checkout (PayPal asks them to agree),
// it pays the next order in one tap, or, with auto-pay on for this live, pays
// for whatever they say a few seconds after their order last changed, up to a
// limit they pick.

export const AUTOPAY_SECONDS = 15;
const LIMITS = [5_000, 10_000, 20_000];

/** The buyer's wallet for this live, refetched whenever their orders change. */
export function useWallet(sessionId: string, buyerToken: string | null, orders: OrderDTO[]) {
  const [wallet, setWallet] = useState<WalletDTO | null>(null);
  // A checkout that just finished may have saved their PayPal.
  const key = orders.map((o) => `${o.id}:${o.status}:${o.updatedAt}`).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: key stands in for the orders
  useEffect(() => {
    if (!buyerToken) return setWallet(null);
    let stale = false;
    api.wallet(sessionId, buyerToken).then(
      (w) => {
        if (!stale) setWallet(w);
      },
      () => undefined,
    );
    return () => {
      stale = true;
    };
  }, [sessionId, buyerToken, key]);
  return [wallet, setWallet] as const;
}

export function AutoPay({
  sessionId,
  buyerToken,
  wallet,
  currency,
  onChange,
}: {
  sessionId: string;
  buyerToken: string;
  wallet: WalletDTO;
  currency: string;
  onChange: (w: WalletDTO) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!wallet.savedPayPal) return null;
  const on = wallet.autopay;

  async function run(task: () => Promise<WalletDTO>) {
    setBusy(true);
    setError(null);
    try {
      onChange(await task());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const chip = (active: boolean) =>
    `rounded-full border-2 border-black px-3 py-1 text-sm font-bold disabled:opacity-50 ${active ? "bg-black text-white" : "bg-label hover:bg-pale"}`;

  return (
    <section className="label" aria-label="Auto-pay">
      <div
        className={`zone flex items-baseline justify-between gap-3 px-3.5 py-2.5 ${on ? "bg-sticker" : ""}`}
      >
        <b className="sort text-[26px]">{on ? "Auto-pay on" : "Auto-pay"}</b>
        <span className="text-right text-[13px] font-semibold">
          {on
            ? `${formatMoney(on.spentCents, currency)} of ${formatMoney(on.limitCents, currency)} used`
            : "just for this live"}
        </span>
      </div>
      <p className="zone px-3.5 py-2.5 text-sm leading-snug">
        {on
          ? `Say +1 and it's paid. ${AUTOPAY_SECONDS} seconds after your order last changes, PlusOne pays with your saved PayPal.`
          : `Let PlusOne pay for what you say tonight: ${AUTOPAY_SECONDS} seconds after your order last changes, it pays with your saved PayPal. No PayPal window.`}
      </p>
      <div className="zone flex flex-wrap items-center gap-2 px-3.5 py-2.5">
        <span className="text-[13px] font-semibold">Up to</span>
        {LIMITS.map((l) => (
          <button
            key={l}
            type="button"
            disabled={busy}
            aria-pressed={on?.limitCents === l}
            onClick={() => void run(() => api.setAutopay(sessionId, l, buyerToken))}
            className={chip(on?.limitCents === l)}
          >
            {formatMoney(l, currency).replace(/\.00$/, "")}
          </button>
        ))}
        {on && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => api.setAutopay(sessionId, null, buyerToken))}
            className={chip(false)}
          >
            Off
          </button>
        )}
      </div>
      <div className="zone flex items-center justify-between gap-3 px-3.5 py-2 text-xs text-quiet">
        <span className="min-w-0 truncate">Saved PayPal: {wallet.savedPayPal}</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => api.forgetPayPal(buyerToken))}
          className="shrink-0 underline decoration-dotted underline-offset-2"
        >
          Forget it
        </button>
      </div>
      {error && <p className="zone px-3.5 py-2 text-sm font-semibold text-pen">{error}</p>}
    </section>
  );
}
