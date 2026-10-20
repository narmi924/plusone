import {
  type OnApproveDataOneTimePayments,
  PayPalOneTimePaymentButton,
} from "@paypal/react-paypal-js/sdk-v6";
import { formatMoney, type OrderDTO, type ProductDTO } from "@plusone/shared";
import { useEffect, useState } from "react";
import { ApiError, api } from "../lib/api";
import { useLive } from "../lib/useLiveRoom";

// The buyer's own page of the seller's order book: what's on screen, what's
// held for them (highlighted, with the hold timer), the PayPal button, and what
// they've paid for (ticked and stamped). Lines sit on the book's 32px rules.

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function countdown(untilIso: string, now: number) {
  const ms = Math.max(0, new Date(untilIso).getTime() - now);
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** "Thu 9:30pm": when an invoice is due, a day or so away. */
export function dueLabel(iso: string) {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-US", { weekday: "short" });
  const time = d
    .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    .toLowerCase()
    .replace(" ", "");
  return `${day} ${time}`;
}

const amount = (cents: number) => (cents / 100).toFixed(2);

function lineText(l: OrderDTO["lines"][number]) {
  const option = [l.color, l.size].filter(Boolean).join(" ");
  return `${l.productName}${option ? `, ${option}` : ""}${l.qty > 1 ? ` x${l.qty}` : ""}`;
}

export function OrderBook({
  product,
  orders,
  buyerToken,
  paypalReady,
  deals,
  ended = false,
}: {
  product: ProductDTO | null;
  orders: OrderDTO[];
  buyerToken: string | null;
  paypalReady: boolean;
  deals: string[];
  ended?: boolean;
}) {
  const open = orders.filter((o) => o.status === "reserved");
  const done = orders.filter((o) => o.status === "paid" || o.status === "shipped");

  return (
    <div className="book min-h-full py-(--rule-h) pr-6 pl-16 text-[15px]">
      {product && <OnScreen product={product} />}
      {deals.map((d) => (
        <p key={d} className="font-hand text-xl leading-(--rule-h) text-pen">
          {d}
        </p>
      ))}

      {ended && open.length === 0 && done.length === 0 ? (
        <p className="mt-(--rule-h) font-hand text-[21px] leading-(--rule-h) text-ink">
          This live has ended. See you at the next one.
        </p>
      ) : (
        !buyerToken && (
          <p className="mt-(--rule-h) font-hand text-[21px] leading-(--rule-h) text-ink">
            Join the chat and say +1. Your order gets written down here.
          </p>
        )
      )}
      {buyerToken && !ended && open.length === 0 && done.length === 0 && (
        <p className="mt-(--rule-h) font-hand text-[21px] leading-(--rule-h) text-ink">
          Nothing yet. Say +1 when you see something you like.
        </p>
      )}
      {buyerToken &&
        open.map((o) => (
          <HeldOrder key={o.id} order={o} buyerToken={buyerToken} paypalReady={paypalReady} />
        ))}
      {done.map((o) => (
        <PaidOrder key={o.id} order={o} />
      ))}
    </div>
  );
}

function OnScreen({ product }: { product: ProductDTO }) {
  const colors = [
    ...new Set(product.variants.map((v) => v.color).filter((c): c is string => Boolean(c))),
  ];
  const sizes = [
    ...new Set(product.variants.map((v) => v.size).filter((s): s is string => Boolean(s))),
  ];
  const gone = (pick: (v: ProductDTO["variants"][number]) => boolean) =>
    product.variants.filter(pick).every((v) => v.available === 0);
  const left = product.variants.reduce((n, v) => n + v.available, 0);
  return (
    <div>
      <div className="text-[13px] leading-(--rule-h) text-quiet">On screen now</div>
      <h2 className="text-[28px] leading-(--rule-h) font-extrabold [font-stretch:90%]">
        {product.name}
      </h2>
      <div className="font-hand text-xl leading-(--rule-h) text-ink">
        {colors.map((c, i) => (
          <span key={c} className={gone((v) => v.color === c) ? "text-[#9aa5c4] line-through" : ""}>
            {c}
            {i < colors.length - 1 ? ", " : ""}
          </span>
        ))}
        {colors.length > 0 && sizes.length > 0 && <span className="mx-2" />}
        {sizes.map((s, i) => (
          <span key={s} className={gone((v) => v.size === s) ? "text-[#9aa5c4] line-through" : ""}>
            {s}
            {i < sizes.length - 1 ? ", " : ""}
          </span>
        ))}
        <span className="ml-3">{left > 0 ? `${left} left` : "sold out"}</span>
      </div>
    </div>
  );
}

function HeldOrder({
  order,
  buyerToken,
  paypalReady,
}: {
  order: OrderDTO;
  buyerToken: string;
  paypalReady: boolean;
}) {
  const now = useNow();
  const upsertOrder = useLive((s) => s.upsertOrder);
  const [status, setStatus] = useState<{ kind: "idle" | "paying" | "error"; text?: string }>({
    kind: "idle",
  });
  const expired = order.holdExpiresAt ? new Date(order.holdExpiresAt).getTime() <= now : false;
  // After the live ends, unpaid holds become a PayPal invoice with its own due date.
  const invoice = order.invoice?.status === "sent" ? order.invoice : null;

  async function onApprove(data: OnApproveDataOneTimePayments) {
    setStatus({ kind: "paying" });
    try {
      upsertOrder(await api.capturePayPal(data.orderId, buyerToken));
      setStatus({ kind: "idle" });
    } catch (err) {
      setStatus({
        kind: "error",
        text:
          err instanceof ApiError && err.status === 422
            ? "PayPal declined that payment. Try again with another card or account."
            : err instanceof Error
              ? err.message
              : String(err),
      });
    }
  }

  return (
    <section className="mt-(--rule-h)" aria-label="Held for you">
      <h3 className="flex items-center justify-between text-base leading-(--rule-h) font-extrabold">
        Held for you
        {invoice ? (
          <span
            className="rounded-[5px] bg-sticker px-2 py-1 text-sm leading-none tabular"
            title="Pay the invoice by then to keep these"
          >
            due {dueLabel(invoice.dueAt)}
          </span>
        ) : (
          order.holdExpiresAt && (
            <span
              className={`rounded-[5px] px-2 py-1 text-sm leading-none tabular ${expired ? "bg-line text-quiet" : "bg-sticker"}`}
              title="Pay before the timer ends to keep these"
            >
              {expired ? "hold ended" : countdown(order.holdExpiresAt, now)}
            </span>
          )
        )}
      </h3>
      <div className="font-hand text-[21px] leading-(--rule-h) text-ink">
        {order.lines
          .filter((l) => l.status === "held")
          .map((l) => (
            <div key={l.id} className="grid grid-cols-[1fr_auto] gap-3">
              <span className="truncate">
                <span className="highlight">{lineText(l)}</span>
              </span>
              <span className="tabular">{amount(l.qty * l.unitPriceCents)}</span>
            </div>
          ))}
        {order.discountCents > 0 && (
          <div className="grid grid-cols-[1fr_auto] gap-3 text-pen">
            <span>bundle deal</span>
            <span className="tabular">−{amount(order.discountCents)}</span>
          </div>
        )}
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <span>
            {order.shipsWithOrderNumber
              ? `postage: one parcel with #${order.shipsWithOrderNumber}`
              : "postage"}
          </span>
          <span className="tabular">
            {order.shipsWithOrderNumber ? "free" : amount(order.shippingCents)}
          </span>
        </div>
        <div className="grid grid-cols-[1fr_auto] gap-3 font-bold">
          <span>total</span>
          <span className="tabular underline decoration-double underline-offset-[5px]">
            {formatMoney(order.totalCents, order.currency)}
          </span>
        </div>
      </div>

      <div className="mt-4 min-h-12">
        {invoice ? (
          <>
            <a
              href={invoice.payUrl ?? undefined}
              target="_blank"
              rel="noreferrer"
              className="block rounded-full bg-[#ffc439] py-3 text-center text-[15px] font-bold text-black hover:brightness-95"
            >
              Pay the PayPal invoice
            </a>
            <p className="mt-2 text-center text-xs text-quiet">
              The live has ended. We emailed you this invoice too; your items stay held until it's
              due.
            </p>
          </>
        ) : status.kind === "paying" ? (
          <p className="py-3 text-center text-sm font-semibold">
            Confirming your payment with PayPal…
          </p>
        ) : paypalReady ? (
          <PayPalOneTimePaymentButton
            type="pay"
            presentationMode="auto"
            createOrder={async () => {
              setStatus({ kind: "idle" });
              const { paypalOrderId } = await api.startPayPal(order.id, buyerToken);
              return { orderId: paypalOrderId };
            }}
            onApprove={onApprove}
            onCancel={() => setStatus({ kind: "idle" })}
            onError={(e) =>
              setStatus({ kind: "error", text: e.message || "PayPal couldn't start. Try again." })
            }
          />
        ) : (
          <p className="py-3 text-center text-sm text-quiet">Loading PayPal…</p>
        )}
      </div>
      {status.kind === "error" && (
        <p className="mt-2 font-hand text-lg leading-snug text-pen">{status.text}</p>
      )}
    </section>
  );
}

function PaidOrder({ order }: { order: OrderDTO }) {
  return (
    <section className="mt-(--rule-h)" aria-label={`Order ${order.number}, paid`}>
      <div className="font-hand text-[21px] leading-(--rule-h) text-ink">
        {order.lines
          .filter((l) => l.status === "paid")
          .map((l) => (
            <div key={l.id} className="grid grid-cols-[auto_1fr_auto] gap-2">
              <span className="font-bold text-paid">✓</span>
              <span className="truncate">{lineText(l)}</span>
              <span className="tabular">{amount(l.qty * l.unitPriceCents)}</span>
            </div>
          ))}
      </div>
      <div className="flex items-center gap-3 leading-(--rule-h)">
        <span className="stamp">{order.status === "shipped" ? "SHIPPED" : "PAID"}</span>
        <span className="text-sm text-quiet tabular">
          {formatMoney(order.totalCents, order.currency)} with PayPal
          {order.captureId && <span className="ml-2 text-xs">ref {order.captureId}</span>}
        </span>
      </div>
      {order.tracking && (
        <p className="font-hand text-xl leading-(--rule-h) text-ink">
          sent by {order.tracking.carrier}, {order.tracking.number}
        </p>
      )}
    </section>
  );
}

/** Phones: the order as a bar above the input; tapping it opens the full page. */
export function MyOrderBar({ orders, onOpen }: { orders: OrderDTO[]; onOpen: () => void }) {
  const now = useNow();
  const open = orders.find((o) => o.status === "reserved");
  if (!open) return null;
  const items = open.lines
    .filter((l) => l.status === "held")
    .map(lineText)
    .join(", ");
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-2xl bg-white py-2.5 pr-2.5 pl-4 text-left text-black shadow-[0_10px_30px_rgb(0_0_0/0.35)] lg:hidden"
    >
      <span className="min-w-0 flex-1">
        <b className="block text-[15px] leading-tight font-extrabold">
          Your order {formatMoney(open.totalCents, open.currency)}
        </b>
        <small className="block truncate text-xs text-quiet">{items}</small>
      </span>
      {open.invoice?.status === "sent" ? (
        <span className="rounded-[5px] bg-sticker px-1.5 py-1 text-[13px] font-extrabold tabular">
          due {dueLabel(open.invoice.dueAt)}
        </span>
      ) : (
        open.holdExpiresAt && (
          <span className="rounded-[5px] bg-sticker px-1.5 py-1 text-[13px] font-extrabold tabular">
            {countdown(open.holdExpiresAt, now)}
          </span>
        )
      )}
      <span className="rounded-lg bg-[#ffc439] px-3 py-2.5 text-sm font-bold">Pay</span>
    </button>
  );
}
