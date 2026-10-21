import {
  type OnApproveDataOneTimePayments,
  PayPalOneTimePaymentButton,
} from "@paypal/react-paypal-js/sdk-v6";
import { formatMoney, type OrderDTO, type SessionDTO } from "@plusone/shared";
import { type ReactNode, useEffect, useState } from "react";
import { ApiError, api } from "../lib/api";
import { swatchStyle } from "../lib/swatch";
import { useLive } from "../lib/useLiveRoom";

// The buyer's side panel: their order as the shipping label it will become.
// From the shop, to them, what's in it with a colour swatch per line, the
// total, and while it's unpaid a yellow block whose bar drains as the hold
// runs down. Paid labels get a barcode and a black PAID strip.

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

/** How much of a hold is left, 0 to 1, for the draining bar. */
export function holdLeft(untilIso: string | null, holdMinutes: number, now: number) {
  if (!untilIso) return 0;
  return Math.min(1, Math.max(0, (Date.parse(untilIso) - now) / (holdMinutes * 60_000)));
}

const amount = (cents: number) => (cents / 100).toFixed(2);
export const sortNumber = (n: number) => String(n).padStart(2, "0");
const liveDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

function option(l: OrderDTO["lines"][number]) {
  return [l.color, l.size].filter(Boolean).join(" ");
}

export function OrderPanel({
  session,
  orders,
  buyerToken,
  buyerName,
  paypalReady,
  sandboxBuyer = null,
  onAdd,
}: {
  session: SessionDTO;
  orders: OrderDTO[];
  buyerToken: string | null;
  buyerName: string | null;
  paypalReady: boolean;
  /** Public demo: the PayPal sandbox login to pay with. */
  sandboxBuyer?: { email: string; password: string } | null;
  /** Put a line in the chat box, e.g. "+1 Puff-Sleeve Blouse ". */
  onAdd: (text: string) => void;
}) {
  const ended = session.status === "ended";
  const open = orders.filter((o) => o.status === "reserved");
  const done = orders.filter((o) => o.status === "paid" || o.status === "shipped");
  const empty = open.length === 0 && done.length === 0;

  return (
    <div className="kraft flex min-h-full flex-col gap-4 px-5 py-7 sm:px-7">
      {empty && (
        <EmptyLabel shop={session.seller.name} to={buyerName}>
          {ended
            ? "This live has ended. See you at the next one."
            : buyerToken
              ? "Nothing yet. Say +1 when you see something you like."
              : "Join the chat and say +1. Your order gets written on this label."}
        </EmptyLabel>
      )}
      {buyerToken &&
        open.map((o) => (
          <HeldOrder
            key={o.id}
            order={o}
            shop={session.seller.name}
            holdMinutes={session.seller.holdMinutes}
            buyerToken={buyerToken}
            paypalReady={paypalReady}
            sandboxBuyer={sandboxBuyer}
          />
        ))}
      {done.map((o) => (
        <PaidOrder key={o.id} order={o} shop={session.seller.name} />
      ))}
      {!ended && <Deals session={session} orders={orders} onAdd={buyerToken ? onAdd : null} />}
    </div>
  );
}

function Head({ shop, number, date }: { shop: string; number: number | null; date: string }) {
  return (
    <div className="zone grid grid-cols-[1fr_88px] sm:grid-cols-[1fr_104px]">
      <div className="px-3.5 py-3">
        <div className="text-xs font-semibold text-quiet">From</div>
        <b className="block text-base leading-tight font-extrabold">{shop}</b>
        <span className="text-[13px] text-quiet">Live, {date}</span>
      </div>
      <div className="sort border-l-[1.5px] border-black pt-4 text-center text-[54px] sm:text-[68px]">
        {number === null ? <span className="text-pen">+1</span> : sortNumber(number)}
      </div>
    </div>
  );
}

function To({ name, note }: { name: string; note: string }) {
  return (
    <div className="zone px-3.5 py-3">
      <div className="text-xs font-semibold text-quiet">To</div>
      <b className="block text-[26px] leading-tight font-extrabold">{name}</b>
      <span className="text-[13px] text-quiet">{note}</span>
    </div>
  );
}

function EmptyLabel({
  shop,
  to,
  children,
}: {
  shop: string;
  to: string | null;
  children: ReactNode;
}) {
  return (
    <section className="label" aria-label="Your order">
      <Head shop={shop} number={null} date={liveDate(new Date().toISOString())} />
      <To name={to ?? "You"} note="Your address comes from PayPal when you pay" />
      <p className="zone px-3.5 py-4 text-[15px] leading-snug">{children}</p>
    </section>
  );
}

function Lines({ lines, muted = false }: { lines: OrderDTO["lines"]; muted?: boolean }) {
  return (
    <>
      {lines.map((l) => (
        <div
          key={l.id}
          className="grid grid-cols-[28px_1fr_auto] items-center gap-2.5 border-t border-line py-2 first:border-t-0"
        >
          <span className="h-7 w-7 rounded-[7px]" style={swatchStyle(l.color)} />
          <span className={`min-w-0 ${muted ? "struck" : ""}`}>
            <b className="block truncate font-bold">{l.productName}</b>
            <small className="text-[13px] text-quiet">
              {[option(l), l.qty > 1 ? `${l.qty} pcs` : ""].filter(Boolean).join(", ") ||
                "One size"}
            </small>
          </span>
          <span className="font-bold tabular">{amount(l.qty * l.unitPriceCents)}</span>
        </div>
      ))}
    </>
  );
}

function Totals({ order }: { order: OrderDTO }) {
  return (
    <>
      {order.discountCents > 0 && (
        <div className="grid grid-cols-[28px_1fr_auto] gap-2.5 border-t border-line py-2 text-pen">
          <span />
          <span className="font-bold">Bundle deal</span>
          <span className="font-bold tabular">−{amount(order.discountCents)}</span>
        </div>
      )}
      <div className="grid grid-cols-[28px_1fr_auto] gap-2.5 border-t border-line py-2">
        <span />
        <span>
          {order.shipsWithOrderNumber
            ? `Postage: one parcel with #${sortNumber(order.shipsWithOrderNumber)}`
            : "Postage"}
        </span>
        <span className="font-bold tabular">
          {order.shipsWithOrderNumber ? "free" : amount(order.shippingCents)}
        </span>
      </div>
    </>
  );
}

function TotalRow({ order }: { order: OrderDTO }) {
  return (
    <div className="zone flex items-baseline justify-between px-3.5 py-3">
      <span className="font-bold">Total</span>
      <b className="text-[36px] leading-none font-black tabular [font-stretch:75%]">
        {formatMoney(order.totalCents, order.currency)}
      </b>
    </div>
  );
}

function HeldOrder({
  order,
  shop,
  holdMinutes,
  buyerToken,
  paypalReady,
  sandboxBuyer,
}: {
  order: OrderDTO;
  shop: string;
  holdMinutes: number;
  buyerToken: string;
  paypalReady: boolean;
  sandboxBuyer: { email: string; password: string } | null;
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
    <section aria-label="Held for you">
      <div className="label">
        <Head shop={shop} number={order.number} date={liveDate(order.createdAt)} />
        <To name={order.buyer.name} note="Your address comes from PayPal when you pay" />
        <div className="zone px-3.5 py-1">
          <Lines lines={order.lines.filter((l) => l.status === "held")} />
          <Totals order={order} />
        </div>
        <TotalRow order={order} />
        <div className="zone bg-sticker px-3.5 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <b className="sort text-[30px]">
              {invoice
                ? `Due ${dueLabel(invoice.dueAt)}`
                : expired
                  ? "Hold ended"
                  : order.holdExpiresAt
                    ? `Held ${countdown(order.holdExpiresAt, now)}`
                    : "Held"}
            </b>
            <span className="text-right text-[13px] font-semibold">
              {invoice ? "pay the invoice to keep it" : "then it goes back on sale"}
            </span>
          </div>
          {!invoice && (
            <div className="drain mt-2 h-2">
              <i style={{ width: `${holdLeft(order.holdExpiresAt, holdMinutes, now) * 100}%` }} />
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 min-h-12">
        {invoice ? (
          <>
            <a
              href={invoice.payUrl ?? undefined}
              target="_blank"
              rel="noreferrer"
              className="block rounded-full bg-[#ffc439] py-3.5 text-center text-[15px] font-bold text-black hover:brightness-95"
            >
              Pay the PayPal invoice
            </a>
            <p className="mt-2 text-center text-xs text-black/70">
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
          <p className="py-3 text-center text-sm text-black/70">Loading PayPal…</p>
        )}
      </div>
      {status.kind === "error" && (
        <p className="mt-2 rounded-[10px] bg-label px-3 py-2 text-sm font-semibold text-pen">
          {status.text}
        </p>
      )}
      {sandboxBuyer && <SandboxLogin {...sandboxBuyer} />}
    </section>
  );
}

/** Public demo: the PayPal sandbox buyer to log in as, tap to copy. */
function SandboxLogin({ email, password }: { email: string; password: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (label: string, text: string) =>
    navigator.clipboard.writeText(text).then(
      () => setCopied(label),
      () => undefined,
    );
  const row = (label: string, text: string) => (
    <div className="flex items-baseline gap-2">
      <span className="w-18 shrink-0 text-quiet">{label}</span>
      <button
        type="button"
        onClick={() => void copy(label, text)}
        className="min-w-0 text-left font-semibold break-all underline decoration-dotted underline-offset-2"
        title="Copy"
      >
        {text}
      </button>
      {copied === label && <span className="text-xs text-paid">copied</span>}
    </div>
  );
  return (
    <div className="mt-3 rounded-[10px] bg-label/85 px-3.5 py-3 text-[13px] leading-relaxed">
      <p className="mb-1 font-bold">Just trying it? PayPal is in test mode. Log in with:</p>
      {row("email", email)}
      {row("password", password)}
    </div>
  );
}

function PaidOrder({ order, shop }: { order: OrderDTO; shop: string }) {
  const shipped = order.status === "shipped";
  return (
    <section className="label" aria-label={`Order ${order.number}, paid`}>
      <Head shop={shop} number={order.number} date={liveDate(order.createdAt)} />
      <To
        name={order.buyer.name}
        note={order.shipTo ? `Sending to ${order.shipTo}` : "Address from your PayPal"}
      />
      <div className="zone px-3.5 py-1">
        <Lines lines={order.lines.filter((l) => l.status === "paid")} />
        <Totals order={order} />
      </div>
      <TotalRow order={order} />
      <div className="zone px-3.5 py-2.5">
        <div className="barcode" aria-hidden="true" />
      </div>
      <div className="zone flex items-center justify-between gap-3 bg-black px-3.5 py-3 text-white">
        <b className="sort text-[26px]">{shipped ? "SHIPPED" : "PAID"}</b>
        <span className="truncate text-right text-[13px]">
          {shipped && order.tracking
            ? `${order.tracking.carrier}, ${order.tracking.number}`
            : `with PayPal${order.captureId ? `, ref ${order.captureId}` : ""}`}
        </span>
      </div>
    </section>
  );
}

/** The host's deals; if the buyer has one piece of a bundle, offer the other. */
function Deals({
  session,
  orders,
  onAdd,
}: {
  session: SessionDTO;
  orders: OrderDTO[];
  onAdd: ((text: string) => void) | null;
}) {
  const mine = new Set(
    orders.flatMap((o) =>
      o.lines.filter((l) => l.status === "held" || l.status === "paid").map((l) => l.productCode),
    ),
  );
  const names = new Map(session.products.map((p) => [p.code, p.name]));
  return (
    <>
      {session.bundles.map((b) => {
        const missing = b.productCodes.filter((c) => !mine.has(c));
        if (missing.length === 0) return null;
        const offer = missing.length < b.productCodes.length ? names.get(missing[0] ?? "") : null;
        return (
          <div
            key={b.summary}
            className="flex items-center gap-3 rounded-[10px] border-2 border-dashed border-black bg-label px-3.5 py-3"
          >
            <div className="min-w-0 flex-1 text-sm">
              <b className="block font-extrabold">{b.summary}</b>
              The host's deal tonight.
            </div>
            {offer && onAdd && (
              <button
                type="button"
                onClick={() => onAdd(`+1 ${offer} `)}
                className="shrink-0 rounded-full border-2 border-black bg-sticker px-3 py-2 text-[13px] font-bold"
              >
                Add the {offer.split(" ").at(-1)?.toLowerCase()}
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}

/** Phones: the order as a small label above the input; tapping it opens the full one. */
export function MyOrderBar({
  orders,
  holdMinutes,
  onOpen,
}: {
  orders: OrderDTO[];
  holdMinutes: number;
  onOpen: () => void;
}) {
  const now = useNow();
  const open = orders.find((o) => o.status === "reserved");
  if (!open) return null;
  const items = open.lines
    .filter((l) => l.status === "held")
    .map((l) => [l.productName, option(l)].filter(Boolean).join(", "))
    .join("; ");
  const invoice = open.invoice?.status === "sent" ? open.invoice : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="grid w-full grid-cols-[52px_1fr_auto] overflow-hidden rounded-[10px] border-2 border-black bg-label text-left text-black shadow-[0_10px_30px_rgb(0_0_0/0.35)] lg:hidden"
    >
      <span className="sort grid place-items-center border-r-[1.5px] border-black text-[30px]">
        {sortNumber(open.number)}
      </span>
      <span className="min-w-0 px-2.5 py-2">
        <b className="font-extrabold">{formatMoney(open.totalCents, open.currency)}</b>{" "}
        <span className="text-sm">
          {invoice
            ? `due ${dueLabel(invoice.dueAt)}`
            : open.holdExpiresAt
              ? `held ${countdown(open.holdExpiresAt, now)}`
              : "held"}
        </span>
        <small className="block truncate text-xs text-quiet">{items}</small>
        {!invoice && (
          <span className="drain mt-1 block h-[5px]">
            <i style={{ width: `${holdLeft(open.holdExpiresAt, holdMinutes, now) * 100}%` }} />
          </span>
        )}
      </span>
      <span className="grid place-items-center border-l-[1.5px] border-black bg-sticker px-4 text-[15px] font-extrabold">
        Pay
      </span>
    </button>
  );
}
