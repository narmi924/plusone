import {
  type OnApproveDataOneTimePayments,
  PayPalOneTimePaymentButton,
} from "@paypal/react-paypal-js/sdk-v6";
import { formatMoney, type OrderDTO, type SessionDTO, type WalletDTO } from "@plusone/shared";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "../lib/api";
import { swatchStyle } from "../lib/swatch";
import { useLive } from "../lib/useLiveRoom";
import { AutoPayRow, useWallet } from "./Wallet";

// The buyer's side: one parcel for the whole live. Everything they've said +1
// to goes on one shipping label; what's paid is marked PAID, what's still held
// adds up at the bottom with the time left and one button to pay. That's all.

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

export const sortNumber = (n: number) => String(n).padStart(2, "0");
const amount = (cents: number) => (cents / 100).toFixed(2);
const option = (l: OrderDTO["lines"][number]) => [l.color, l.size].filter(Boolean).join(" ");

/** Auto-pay counts down from when this copy of the order arrived, not the server's clock. */
function useAutopayDeadline(order: OrderDTO | undefined) {
  return useMemo(
    () => (order?.autopayInMs == null ? null : Date.now() + order.autopayInMs),
    [order],
  );
}

type ParcelLine = OrderDTO["lines"][number] & { orderStatus: OrderDTO["status"] };

/** Every item from tonight's orders, newest first: what's held, then what's paid. */
function parcelLines(open: OrderDTO | undefined, done: OrderDTO[]): ParcelLine[] {
  const held = (open?.lines ?? [])
    .filter((l) => l.status === "held")
    .map((l) => ({ ...l, orderStatus: "reserved" as const }));
  const paid = done.flatMap((o) =>
    o.lines
      .filter((l) => l.status === "paid" || l.status === "refunded")
      .map((l) => ({ ...l, orderStatus: o.status })),
  );
  return [...held.reverse(), ...paid];
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
  const open = orders.find((o) => o.status === "reserved");
  const done = orders.filter((o) => o.status === "paid" || o.status === "shipped");
  const [wallet, setWallet] = useWallet(session.id, buyerToken, orders);
  // A fully refunded order is cancelled; its items still show, struck through.
  const refunded = orders.filter(
    (o) => o.status === "cancelled" && o.lines.some((l) => l.status === "refunded"),
  );
  const lines = parcelLines(open, [...done, ...refunded]);
  const items = lines.filter((l) => l.status !== "refunded").reduce((n, l) => n + l.qty, 0);
  const paidCents = done.reduce((n, o) => n + o.totalCents, 0);
  const currency = session.seller.currency;

  return (
    <div className="kraft flex min-h-full flex-col px-5 py-7 sm:px-7">
      <section className="label" aria-label="Your parcel">
        <div className="zone flex items-end justify-between gap-3 px-4 py-3.5">
          <div className="min-w-0">
            <p className="text-[13px] text-quiet">Your parcel from {session.seller.name}</p>
            <p className="truncate text-2xl leading-tight font-extrabold">
              To {buyerName ?? "you"}
            </p>
          </div>
          {items > 0 && (
            <div className="shrink-0 text-right">
              <b className="sort block text-[46px]">{items}</b>
              <span className="text-xs text-quiet">{items === 1 ? "item" : "items"}</span>
            </div>
          )}
        </div>

        {lines.length === 0 ? (
          <p className="zone px-4 py-4 leading-snug">
            {ended
              ? "This live has ended. See you at the next one."
              : buyerToken
                ? "Say +1 when you see something you like. It goes in this parcel."
                : "Join the chat and say +1. What you order goes in this parcel."}
          </p>
        ) : (
          <div className="zone px-4 py-1">
            {lines.map((l, i) => (
              <ItemRow key={l.id} line={l} first={i === 0} />
            ))}
            {open && <OpenExtras order={open} hasPaid={done.length > 0} />}
          </div>
        )}

        {open ? (
          <Status order={open} holdMinutes={session.seller.holdMinutes} wallet={wallet} />
        ) : (
          done.length > 0 && <Settled orders={done} paidCents={paidCents} currency={currency} />
        )}

        {buyerToken && wallet?.savedPayPal && !ended && (
          <AutoPayRow
            sessionId={session.id}
            buyerToken={buyerToken}
            wallet={wallet}
            currency={currency}
            onChange={setWallet}
          />
        )}
      </section>

      {buyerToken && open && (
        <PayAction
          order={open}
          buyerToken={buyerToken}
          paypalReady={paypalReady}
          sandboxBuyer={sandboxBuyer}
          wallet={wallet}
          onWallet={setWallet}
          paidCents={paidCents}
        />
      )}

      {!ended && buyerToken && <DealOffer session={session} orders={orders} onAdd={onAdd} />}
    </div>
  );
}

function ItemRow({ line, first }: { line: ParcelLine; first: boolean }) {
  const refunded = line.status === "refunded";
  const tag = refunded
    ? null
    : line.orderStatus === "shipped"
      ? "SENT"
      : line.orderStatus === "paid"
        ? "PAID"
        : null;
  return (
    <div
      className={`flex items-center gap-3 py-2.5 ${first ? "" : "border-t border-line"} ${refunded ? "opacity-60" : ""}`}
    >
      <span className="h-8 w-8 shrink-0 rounded-md" style={swatchStyle(line.color)} />
      <div className="min-w-0 flex-1">
        <p className={`truncate text-base font-bold ${refunded ? "struck" : ""}`}>
          {line.productName}
          {line.qty > 1 && <span className="ml-1 font-semibold">x{line.qty}</span>}
        </p>
        <p className="text-[13px] text-quiet">
          {refunded ? "Refunded" : option(line) || "One size"}
        </p>
      </div>
      {tag ? (
        <span className="rounded bg-black px-1.5 py-0.5 text-[11px] font-black tracking-wide text-white">
          {tag}
        </span>
      ) : (
        !refunded && (
          <span className="text-base font-semibold tabular">
            {amount(line.qty * line.unitPriceCents)}
          </span>
        )
      )}
    </div>
  );
}

/** Postage and deals on what's still to pay. */
function OpenExtras({ order, hasPaid }: { order: OrderDTO; hasPaid: boolean }) {
  return (
    <>
      {order.discountCents > 0 && (
        <div className="flex justify-between border-t border-line py-2 text-[13px] font-semibold text-pen">
          <span>Bundle deal</span>
          <span className="tabular">−{amount(order.discountCents)}</span>
        </div>
      )}
      {(order.shippingCents > 0 || hasPaid) && (
        <div className="flex justify-between border-t border-line py-2 text-[13px] text-quiet">
          <span>Postage{order.shipsWithOrderNumber ? ", same parcel" : ""}</span>
          <span className="tabular">
            {order.shippingCents > 0 ? amount(order.shippingCents) : "free"}
          </span>
        </div>
      )}
    </>
  );
}

/** The bottom of the label while something is held: how much, and how long. */
function Status({
  order,
  holdMinutes,
  wallet,
}: {
  order: OrderDTO;
  holdMinutes: number;
  wallet: WalletDTO | null;
}) {
  const now = useNow(250);
  const deadline = useAutopayDeadline(order);
  const autopayLeft = wallet?.autopay && deadline ? Math.max(0, deadline - now) : null;
  const invoice = order.invoice?.status === "sent" ? order.invoice : null;
  const expired = order.holdExpiresAt ? Date.parse(order.holdExpiresAt) <= now : false;
  const total = <b className="sort text-[46px]">{formatMoney(order.totalCents, order.currency)}</b>;

  if (autopayLeft !== null) {
    return (
      <section aria-label="Auto-pay countdown" className="zone bg-black px-4 py-3 text-white">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-xs font-bold">Auto-pay with your saved PayPal</p>
            <b className="sort text-[34px]">
              {autopayLeft > 0 ? `in ${Math.ceil(autopayLeft / 1000)}s` : "paying…"}
            </b>
          </div>
          {total}
        </div>
        <div className="drain on-dark mt-2.5">
          <i style={{ width: `${Math.min(1, autopayLeft / 15_000) * 100}%` }} />
        </div>
      </section>
    );
  }
  return (
    <section aria-label="Held for you" className="zone bg-sticker px-4 py-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold">
            {invoice ? "Pay the invoice by" : expired ? "The hold ran out" : "To pay, held for you"}
          </p>
          <b className="sort text-[34px]">
            {invoice
              ? dueLabel(invoice.dueAt)
              : order.holdExpiresAt && !expired
                ? countdown(order.holdExpiresAt, now)
                : "0:00"}
          </b>
        </div>
        {total}
      </div>
      {!invoice && (
        <div className="drain mt-2.5">
          <i style={{ width: `${holdLeft(order.holdExpiresAt, holdMinutes, now) * 100}%` }} />
        </div>
      )}
    </section>
  );
}

/** Nothing left to pay: the label gets its barcode. */
function Settled({
  orders,
  paidCents,
  currency,
}: {
  orders: OrderDTO[];
  paidCents: number;
  currency: string;
}) {
  const sent = orders.find((o) => o.status === "shipped" && o.tracking);
  return (
    <>
      <div className="zone px-4 py-2.5">
        <div className="barcode" aria-hidden="true" />
      </div>
      <div className="zone flex items-center justify-between gap-3 bg-black px-4 py-3 text-white">
        <b className="sort text-[26px]">{sent ? "SENT" : "PAID"}</b>
        <span className="truncate text-right text-[13px]">
          {sent?.tracking
            ? `${sent.tracking.carrier}, ${sent.tracking.number}`
            : `${formatMoney(paidCents, currency)} with PayPal`}
        </span>
      </div>
    </>
  );
}

function PayAction({
  order,
  buyerToken,
  paypalReady,
  sandboxBuyer,
  wallet,
  onWallet,
  paidCents,
}: {
  order: OrderDTO;
  buyerToken: string;
  paypalReady: boolean;
  sandboxBuyer: { email: string; password: string } | null;
  wallet: WalletDTO | null;
  onWallet: (w: WalletDTO) => void;
  paidCents: number;
}) {
  const upsertOrder = useLive((s) => s.upsertOrder);
  const [status, setStatus] = useState<{ kind: "idle" | "paying" | "error"; text?: string }>({
    kind: "idle",
  });
  // PayPal asks the buyer to agree to saving on its own page; this only asks for it.
  const [save, setSave] = useState(true);
  const saveRef = useRef(save);
  saveRef.current = save;
  const [otherWay, setOtherWay] = useState(false);
  const deadline = useAutopayDeadline(order);
  const counting = Boolean(wallet?.autopay && deadline);
  const invoice = order.invoice?.status === "sent" ? order.invoice : null;
  const saved = wallet?.savedPayPal ?? null;
  const total = formatMoney(order.totalCents, order.currency);

  const failed = (err: unknown) =>
    setStatus({
      kind: "error",
      text:
        err instanceof ApiError && err.status === 422
          ? "PayPal declined that payment. Try again with another card or account."
          : err instanceof Error
            ? err.message
            : String(err),
    });

  async function onApprove(data: OnApproveDataOneTimePayments) {
    setStatus({ kind: "paying" });
    try {
      upsertOrder(await api.capturePayPal(data.orderId, buyerToken));
      setStatus({ kind: "idle" });
    } catch (err) {
      failed(err);
    }
  }

  async function paySaved() {
    setStatus({ kind: "paying", text: "Paying with your saved PayPal…" });
    try {
      upsertOrder(await api.paySaved(order.id, buyerToken));
      setStatus({ kind: "idle" });
    } catch (err) {
      failed(err);
    }
  }

  async function payMyself() {
    try {
      onWallet(await api.setAutopay(order.sessionId, null, buyerToken));
    } catch (err) {
      failed(err);
    }
  }

  const quiet = (children: ReactNode) => (
    <p className="mt-2 text-center text-xs text-black/65">{children}</p>
  );
  const link = "font-semibold underline decoration-dotted underline-offset-2";

  return (
    <div className="mt-4">
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
          {quiet("The live has ended. Your items stay held until the invoice is due.")}
        </>
      ) : status.kind === "paying" ? (
        <p className="py-3 text-center text-sm font-semibold">
          {status.text ?? "Confirming your payment with PayPal…"}
        </p>
      ) : counting ? (
        <button
          type="button"
          onClick={() => void payMyself()}
          className="w-full rounded-full border-2 border-black bg-label py-3 text-sm font-bold"
        >
          Stop auto-pay, I'll pay myself
        </button>
      ) : saved && !otherWay ? (
        <>
          <button
            type="button"
            onClick={() => void paySaved()}
            className="w-full rounded-full bg-[#ffc439] py-3.5 text-[15px] font-bold text-black hover:brightness-95"
          >
            Pay {total} with saved PayPal
          </button>
          {quiet(
            <>
              {paidCents > 0 && (
                <span className="mr-3">Paid so far: {formatMoney(paidCents, order.currency)}</span>
              )}
              <button type="button" onClick={() => setOtherWay(true)} className={link}>
                Pay another way
              </button>
            </>,
          )}
        </>
      ) : paypalReady ? (
        <>
          <PayPalOneTimePaymentButton
            type="pay"
            presentationMode="auto"
            createOrder={async () => {
              setStatus({ kind: "idle" });
              const { paypalOrderId } = await api.startPayPal(
                order.id,
                buyerToken,
                !saved && saveRef.current,
              );
              return { orderId: paypalOrderId };
            }}
            onApprove={onApprove}
            onCancel={() => setStatus({ kind: "idle" })}
            onError={(e) =>
              setStatus({ kind: "error", text: e.message || "PayPal couldn't start. Try again." })
            }
          />
          {!saved && (
            <label className="mt-2.5 flex cursor-pointer items-center justify-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={save}
                onChange={(e) => setSave(e.target.checked)}
                className="size-4 accent-black"
              />
              Save my PayPal for one tap next time
            </label>
          )}
          {sandboxBuyer && <SandboxLogin {...sandboxBuyer} />}
        </>
      ) : (
        <p className="py-3 text-center text-sm text-black/70">Loading PayPal…</p>
      )}
      {status.kind === "error" && (
        <p className="mt-2 rounded-[10px] bg-label px-3 py-2 text-sm font-semibold text-pen">
          {status.text}
        </p>
      )}
    </div>
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
  const value = (label: string, text: string) => (
    <button
      type="button"
      onClick={() => void copy(label, text)}
      className="font-semibold break-all underline decoration-dotted underline-offset-2"
      title="Copy"
    >
      {copied === label ? "copied" : text}
    </button>
  );
  return (
    <p className="mt-3 text-center text-xs leading-relaxed text-black/70">
      PayPal is in test mode. Log in with {value("email", email)} and {value("password", password)}
    </p>
  );
}

/** One piece of the host's bundle in the parcel: offer the other. */
function DealOffer({
  session,
  orders,
  onAdd,
}: {
  session: SessionDTO;
  orders: OrderDTO[];
  onAdd: (text: string) => void;
}) {
  const mine = new Set(
    orders.flatMap((o) =>
      o.lines.filter((l) => l.status === "held" || l.status === "paid").map((l) => l.productCode),
    ),
  );
  const names = new Map(session.products.map((p) => [p.code, p.name]));
  const offers = session.bundles.flatMap((b) => {
    const missing = b.productCodes.filter((c) => !mine.has(c));
    const name = names.get(missing[0] ?? "");
    return missing.length > 0 && missing.length < b.productCodes.length && name
      ? [{ summary: b.summary, name }]
      : [];
  });
  return (
    <>
      {offers.map((o) => (
        <div
          key={o.summary}
          className="mt-4 flex items-center gap-3 rounded-[10px] border-2 border-dashed border-black/60 px-3.5 py-2.5"
        >
          <span className="min-w-0 flex-1 text-sm font-bold">{o.summary}</span>
          <button
            type="button"
            onClick={() => onAdd(`+1 ${o.name} `)}
            className="shrink-0 rounded-full border-2 border-black bg-label px-3 py-1.5 text-[13px] font-bold"
          >
            Add the {o.name.split(" ").at(-1)?.toLowerCase()}
          </button>
        </div>
      ))}
    </>
  );
}

/** Phones: the parcel as a small bar above the input; tapping it opens the whole label. */
export function MyOrderBar({
  orders,
  onOpen,
}: {
  orders: OrderDTO[];
  holdMinutes: number;
  onOpen: () => void;
}) {
  const now = useNow();
  const open = orders.find((o) => o.status === "reserved");
  const autopayAt = useAutopayDeadline(open);
  if (!open) return null;
  const done = orders.filter((o) => o.status === "paid" || o.status === "shipped");
  const items = parcelLines(open, done)
    .filter((l) => l.status !== "refunded")
    .reduce((n, l) => n + l.qty, 0);
  const invoice = open.invoice?.status === "sent" ? open.invoice : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-stretch overflow-hidden rounded-[10px] border-2 border-black bg-label text-left text-black shadow-[0_10px_30px_rgb(0_0_0/0.35)] lg:hidden"
    >
      <span className="min-w-0 flex-1 px-3 py-2">
        <small className="block text-xs text-quiet">
          Your parcel, {items} {items === 1 ? "item" : "items"}
        </small>
        <b className="font-extrabold">To pay {formatMoney(open.totalCents, open.currency)}</b>{" "}
        <span className="text-sm">
          {invoice
            ? `due ${dueLabel(invoice.dueAt)}`
            : autopayAt
              ? `auto-pay in ${Math.max(0, Math.ceil((autopayAt - now) / 1000))}s`
              : open.holdExpiresAt
                ? `held ${countdown(open.holdExpiresAt, now)}`
                : "held"}
        </span>
      </span>
      <span className="grid place-items-center bg-[#ffc439] px-5 text-[15px] font-extrabold">
        Pay
      </span>
    </button>
  );
}
