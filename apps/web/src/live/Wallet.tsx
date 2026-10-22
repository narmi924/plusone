import { formatMoney, type OrderDTO, type WalletDTO } from "@plusone/shared";
import { useEffect, useState } from "react";
import { api } from "../lib/api";

// The buyer's saved PayPal. Saved once at checkout (PayPal asks them to agree),
// it pays the next order in one tap, or, with auto-pay on for this live, pays
// for whatever they say a few seconds after their order last changed, up to a
// limit they pick.

const LIMITS = [5_000, 10_000, 20_000];
const DEFAULT_LIMIT = 10_000;

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

/** The last line of the parcel: one switch, the limit, and a way to forget the saved PayPal. */
export function AutoPayRow({
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
  const on = wallet.autopay;
  const [limit, setLimit] = useState(on?.limitCents ?? DEFAULT_LIMIT);
  const money = (cents: number) => formatMoney(cents, currency).replace(/\.00$/, "");

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

  return (
    <section aria-label="Auto-pay" className="zone px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold">Auto-pay my +1s tonight</p>
          <p className="text-xs text-quiet">
            Up to{" "}
            <select
              value={limit}
              disabled={busy}
              aria-label="Auto-pay limit"
              onChange={(e) => {
                const next = Number(e.target.value);
                setLimit(next);
                if (on) void run(() => api.setAutopay(sessionId, next, buyerToken));
              }}
              className="cursor-pointer bg-transparent font-semibold text-black underline decoration-dotted underline-offset-2 [field-sizing:content]"
            >
              {LIMITS.map((l) => (
                <option key={l} value={l}>
                  {money(l)}
                </option>
              ))}
            </select>
            <span className="ml-1">
              {on ? `${money(on.spentCents)} used` : "with your saved PayPal"}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => api.forgetPayPal(buyerToken))}
              className="ml-2 underline decoration-dotted underline-offset-2"
            >
              Forget it
            </button>
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={Boolean(on)}
          aria-label="Auto-pay my +1s tonight"
          disabled={busy}
          onClick={() => void run(() => api.setAutopay(sessionId, on ? null : limit, buyerToken))}
          className={`relative h-6 w-10 shrink-0 rounded-full transition-colors disabled:opacity-60 ${on ? "bg-black" : "bg-[#cfc6b8]"}`}
        >
          <span
            className={`absolute top-0.75 h-4.5 w-4.5 rounded-full bg-white transition-all ${on ? "left-4.75" : "left-0.75"}`}
          />
        </button>
      </div>
      {error && <p className="mt-1.5 text-sm font-semibold text-pen">{error}</p>}
    </section>
  );
}
