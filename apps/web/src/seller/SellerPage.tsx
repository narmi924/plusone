import {
  formatMoney,
  type OrderDTO,
  type ProductDTO,
  type RecapDTO,
  type WaitingDTO,
} from "@plusone/shared";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { ago, recentClaims } from "../lib/claims";
import { useHostSpeech } from "../lib/speech";
import { readStored, SELLER_TOKEN_KEY, writeStored } from "../lib/storage";
import { productSwatch, swatchStyle } from "../lib/swatch";
import { useLive, useLiveRoom } from "../lib/useLiveRoom";
import { TrackVideo, useHostCamera } from "../lib/video";
import { ChatFeed } from "../live/Chat";
import { dueLabel, holdLeft, sortNumber } from "../live/OrderSlip";
import { ConsoleTabs } from "./ConsoleTabs";
import { Copilot } from "./Copilot";
import { VoiceCards, VoiceControl } from "./HostVoice";
import { NeedsYou } from "./NeedsYou";

// The host's screen during a live. Every order is a shipping label on the
// table, sorted into the night's three lanes: waiting for money (its yellow
// hold bar draining), paid and ready to pack, sent. What only the seller can
// decide comes on red tape across the top. Camera, voice and products on the
// left; the whole chat, including PlusOne's private replies, on the right.

export function SellerPage() {
  const [token, setToken] = useState<string | null>(() => readStored(SELLER_TOKEN_KEY));
  if (!token) {
    return (
      <SellerLogin
        onToken={(t) => {
          writeStored(SELLER_TOKEN_KEY, t);
          setToken(t);
        }}
      />
    );
  }
  return (
    <Console
      token={token}
      onSignOut={() => {
        writeStored(SELLER_TOKEN_KEY, null);
        setToken(null);
      }}
    />
  );
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function Console({ token, onSignOut }: { token: string; onSignOut: () => void }) {
  const { error, reload, hostListen, hostAudio } = useLiveRoom({
    handle: "lumicloset",
    sellerToken: token,
  });
  const session = useLive((s) => s.session);
  const orders = useLive((s) => s.orders);
  const messages = useLive((s) => s.messages);
  const thinking = useLive((s) => s.thinking);
  const waitlistVersion = useLive((s) => s.waitlistVersion);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<WaitingDTO[]>([]);
  const [demo, setDemo] = useState(false);
  const [crowd, setCrowd] = useState<"idle" | "playing">("idle");
  const camera = useHostCamera(session?.id ?? null, token);
  const speech = useHostSpeech({ hostListen, hostAudio }, camera.mic);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when someone joins or leaves a line, or orders move
  useEffect(() => {
    if (session?.id) api.waitlist(session.id, token).then(setWaiting, () => undefined);
  }, [session?.id, token, waitlistVersion, orders]);

  useEffect(() => {
    api.config().then(
      (c) => setDemo(Boolean(c.demo)),
      () => undefined,
    );
  }, []);

  // Number keys put products on screen without reaching for the mouse mid-live.
  const shortcutRef = useRef<(key: string) => void>(() => undefined);
  shortcutRef.current = (key) => {
    const product = session?.products[Number(key) - 1];
    if (session && product) void api.showcase(session.id, product.id, token);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        target?.closest("input, textarea, select, [contenteditable]")
      )
        return;
      if (/^[1-9]$/.test(e.key)) shortcutRef.current(e.key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (error) {
    return (
      <div className="p-8">
        <p className="text-quiet">The console couldn't load: {error}</p>
        <button type="button" className="mt-3 underline" onClick={onSignOut}>
          Sign in again
        </button>
      </div>
    );
  }
  if (!session) return <p className="p-8 text-black/70">Opening tonight's orders…</p>;

  const currency = session.seller.currency;
  const byNumber = [...orders].sort((a, b) => a.number - b.number);
  const owing = byNumber.filter((o) => o.status === "reserved");
  const paid = byNumber.filter((o) => o.status === "paid");
  const sent = byNumber.filter((o) => o.status === "shipped");
  const cancelled = byNumber.filter((o) => o.status === "cancelled");
  const owed = owing.reduce((n, o) => n + o.totalCents, 0);
  const taken = [...paid, ...sent].reduce((n, o) => n + o.totalCents, 0);
  const money = (cents: number) => formatMoney(cents, currency).replace(".00", "");

  async function endLive() {
    if (!session) return;
    const ok = window.confirm(
      "End the live? Anyone still holding unpaid items gets a PayPal invoice by email and keeps their items until tomorrow.",
    );
    if (!ok) return;
    setBusy(true);
    try {
      await api.endLive(session.id, token);
    } finally {
      setBusy(false);
    }
  }

  async function playCrowd() {
    if (!session) return;
    setCrowd("playing");
    try {
      await api.playCrowd(session.id, token);
    } catch {
      // Already playing, or not the demo: nothing to undo.
    }
    setTimeout(() => setCrowd("idle"), 40_000);
  }

  async function reset() {
    if (!window.confirm("Clear all orders and chat and restock the demo?")) return;
    setBusy(true);
    try {
      await api.resetDemo(token);
      reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <ConsoleTabs
        sellerName={session.seller.name}
        current="book"
        ended={session.status === "ended"}
      >
        <Stat value={money(owed)} label={`${owing.length} waiting to pay`} />
        <Stat value={money(taken)} label={`${paid.length + sent.length} paid`} paid />
        {session.status !== "ended" && (
          <button
            type="button"
            disabled={busy}
            onClick={endLive}
            className="rounded-full border-2 border-black px-3.5 py-1.5 text-sm font-bold disabled:opacity-50"
          >
            End live
          </button>
        )}
        {demo && session.status !== "ended" && (
          <button
            type="button"
            disabled={crowd === "playing"}
            onClick={() => void playCrowd()}
            className="rounded-full border-2 border-black bg-sticker px-3.5 py-1.5 text-sm font-bold disabled:opacity-60"
            title="Ten buyers talk the way they do in a real live; PlusOne handles them"
          >
            {crowd === "playing" ? "Buyers are chatting…" : "Play a busy minute"}
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={reset}
          className="text-sm text-quiet underline hover:text-black"
        >
          Reset demo
        </button>
      </ConsoleTabs>
      <ClaimTicker />

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)_320px]">
        <aside
          className="flex flex-col gap-3 overflow-y-auto border-r-2 border-black bg-label p-4"
          aria-label="Camera and products"
        >
          <CameraPanel camera={camera} />
          <VoiceControl speech={speech} />
          <ProductList
            products={session.products}
            currentId={session.currentProductId}
            sessionId={session.id}
            token={token}
          />
        </aside>

        <main className="kraft overflow-y-auto p-5" aria-label="Tonight's order book">
          {session.status === "ended" && <AfterLive sessionId={session.id} token={token} />}
          <Copilot sessionId={session.id} token={token} />
          <NeedsYou sessionId={session.id} token={token} />
          <VoiceCards sessionId={session.id} token={token} />
          <div className="grid items-start gap-4 xl:grid-cols-3">
            <Lane title="Waiting to pay" count={owing.length}>
              {owing.map((o) => (
                <OrderLabel
                  key={o.id}
                  order={o}
                  token={token}
                  holdMinutes={session.seller.holdMinutes}
                />
              ))}
              {waiting.map((w) => (
                <WaitingCard key={w.id} entry={w} />
              ))}
              {owing.length === 0 && waiting.length === 0 && (
                <Empty>Orders land here as buyers say +1.</Empty>
              )}
              {cancelled.length > 0 && (
                <p className="text-[13px] text-black/70">
                  {cancelled.length} cancelled: {cancelled.map((o) => o.buyer.name).join(", ")}.
                  Their items went back on sale.
                </p>
              )}
            </Lane>
            <Lane title="Paid, pack it" count={paid.length}>
              {paid.map((o) => (
                <OrderLabel
                  key={o.id}
                  order={o}
                  token={token}
                  holdMinutes={session.seller.holdMinutes}
                />
              ))}
              {paid.length === 0 && <Empty>Paid orders land here, ready to pack.</Empty>}
            </Lane>
            <Lane title="Sent" count={sent.length}>
              {sent.map((o) => (
                <OrderLabel
                  key={o.id}
                  order={o}
                  token={token}
                  holdMinutes={session.seller.holdMinutes}
                />
              ))}
              {sent.length === 0 && (
                <Empty>
                  Labels you ship move here, with the tracking number PayPal shows the buyer.
                </Empty>
              )}
            </Lane>
          </div>
        </main>

        <aside
          className="overflow-y-auto border-l-2 border-black bg-label px-4 py-4 text-sm"
          aria-label="Chat"
        >
          <ChatFeed messages={messages} thinking={thinking} myBuyerId={null} variant="panel" />
        </aside>
      </div>
    </div>
  );
}

function Stat({ value, label, paid = false }: { value: string; label: string; paid?: boolean }) {
  return (
    <span className="flex flex-col leading-none">
      <b className={`text-[22px] font-black [font-stretch:75%] ${paid ? "text-paid" : ""}`}>
        {value}
      </b>
      <span className="mt-0.5 text-xs font-semibold text-quiet">{label}</span>
    </span>
  );
}

/** Who just got what, newest first, like the room sees it. */
function ClaimTicker() {
  const messages = useLive((s) => s.messages);
  const now = useNow(5_000);
  // biome-ignore lint/correctness/useExhaustiveDependencies: now ticks so the ages stay right
  const claims = useMemo(() => recentClaims(messages, { limit: 8 }), [messages, now]);
  return (
    <section
      className="flex h-11 shrink-0 items-center gap-2 overflow-hidden border-b-[1.5px] border-black/15 bg-paper px-6 whitespace-nowrap"
      aria-label="Latest +1s"
    >
      {claims.length === 0 ? (
        <span className="text-[13px] text-quiet">The latest +1s show up here.</span>
      ) : (
        claims.map((c) => (
          <span
            key={c.id}
            className="rounded-full bg-label px-3 py-1 text-[13px] font-semibold shadow-[0_1px_2px_rgb(80_50_10/0.15)]"
          >
            <b className="mr-1 text-pen">+1</b>
            {c.who}, {c.what}
            <span className="ml-1.5 font-normal text-quiet">{ago(c.at, now)}</span>
          </span>
        ))
      )}
    </section>
  );
}

function Lane({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-3">
      <h2 className="flex items-center gap-2 text-sm font-extrabold">
        {title}
        <span className="rounded-full bg-black px-2 py-0.5 text-xs text-white tabular">
          {count}
        </span>
      </h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-label border-2 border-dashed border-black/35 px-3 py-3.5 text-[13px] text-black/70">
      {children}
    </p>
  );
}

const CARRIERS = [
  { key: "singpost", label: "SingPost" },
  { key: "ninjavan", label: "Ninja Van" },
  { key: "jt", label: "J&T Express" },
  { key: "dhl", label: "DHL" },
  { key: "other", label: "Other" },
] as const;

/** One order as a label: who, what, and what happens next. */
function OrderLabel({
  order,
  token,
  holdMinutes,
}: {
  order: OrderDTO;
  token: string;
  holdMinutes: number;
}) {
  const now = useNow(1_000);
  const [shipping, setShipping] = useState(false);
  const [reminded, setReminded] = useState<string | null>(null);
  const invoice = order.status === "reserved" && order.invoice?.status === "sent";
  const left = order.holdExpiresAt ? Date.parse(order.holdExpiresAt) - now : 0;
  const amount = (cents: number) => (cents / 100).toFixed(2);

  async function remind() {
    try {
      const r = await api.remind(order.sessionId, order.number, token);
      setReminded(`Reminded, ${r.minutesLeft} min left`);
    } catch (err) {
      setReminded(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <article className="label" aria-label={`Order ${order.number}, ${order.buyer.name}`}>
      <div className="zone grid grid-cols-[1fr_64px]">
        <div className="px-2.5 py-2">
          <small className="block text-[11px] font-semibold text-quiet">To</small>
          <b className="block truncate text-lg leading-tight font-extrabold">{order.buyer.name}</b>
        </div>
        <div className="sort border-l-[1.5px] border-black pt-2.5 text-center text-[36px]">
          {sortNumber(order.number)}
        </div>
      </div>
      <div className="zone px-2.5 py-2">
        {order.lines.map((l) => {
          const live = l.status === "held" || l.status === "paid";
          const option = [l.color, l.size].filter(Boolean).join(" ");
          return (
            <div
              key={l.id}
              className={`grid grid-cols-[16px_1fr_auto] items-start gap-2 py-0.5 ${live ? "" : "struck text-[13px]"}`}
            >
              <i className="mt-0.5 h-4 w-4 rounded-sm" style={swatchStyle(l.color)} />
              <span className="min-w-0 leading-snug">
                {l.productName}
                {option && (
                  <span className="ml-1 text-[13px] whitespace-nowrap text-quiet">{option}</span>
                )}
                {l.qty > 1 && <span className="ml-1 text-[13px]">x{l.qty}</span>}
              </span>
              <span className="font-bold tabular">
                {live ? amount(l.qty * l.unitPriceCents) : ""}
              </span>
            </div>
          );
        })}
        {order.discountCents > 0 && (
          <div className="text-[13px] font-bold text-pen">
            Bundle deal −{amount(order.discountCents)}
          </div>
        )}
        {order.shipsWithOrderNumber && (
          <div className="text-[12.5px] text-quiet">
            One parcel with #{sortNumber(order.shipsWithOrderNumber)}
          </div>
        )}
        {order.status === "paid" && order.shipTo && (
          <div className="mt-1 text-[12.5px] text-quiet">{order.shipTo}</div>
        )}
        {order.status === "reserved" && !invoice && (
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void remind()}
              className="rounded-full border-2 border-black px-2.5 py-0.5 text-xs font-bold"
            >
              Remind
            </button>
            {reminded && <span className="text-xs text-quiet">{reminded}</span>}
          </div>
        )}
        {shipping && <ShipForm order={order} token={token} onDone={() => setShipping(false)} />}
      </div>

      {order.status === "reserved" &&
        (invoice && order.invoice ? (
          <div className="zone flex items-center justify-between gap-2 bg-pale px-2.5 py-2">
            <span className="whitespace-nowrap">
              <span className="mr-1.5 text-[13px] font-semibold">invoiced</span>
              <b className="sort text-[19px]">{dueLabel(order.invoice.dueAt)}</b>
            </span>
            <span className="font-extrabold tabular">
              {formatMoney(order.totalCents, order.currency).replace(".00", "")}
            </span>
          </div>
        ) : (
          <div className="zone bg-pale px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
              <b className="sort text-[19px]">
                {order.autopayAt
                  ? "auto-paying"
                  : left > 0
                    ? `${Math.ceil(left / 60_000)} min left`
                    : "Hold ending"}
              </b>
              <span className="font-extrabold tabular">
                {formatMoney(order.totalCents, order.currency).replace(".00", "")}
              </span>
            </div>
            <div className="drain mt-1.5">
              <i style={{ width: `${holdLeft(order.holdExpiresAt, holdMinutes, now) * 100}%` }} />
            </div>
          </div>
        ))}

      {(order.status === "paid" || order.status === "shipped") && (
        <>
          <div className="zone px-2.5 py-2">
            <div className="barcode" aria-hidden="true" />
          </div>
          <div className="zone flex items-center justify-between gap-2 bg-black px-2.5 py-2 text-white">
            <span className="min-w-0">
              <b className="sort mr-1.5 text-[19px]">
                {order.status === "shipped" ? "SHIPPED" : "PAID"}
              </b>
              <span className="text-[12.5px] text-white/80">
                {order.status === "shipped" && order.tracking
                  ? `${order.tracking.carrier} ${order.tracking.number}`
                  : order.paidVia === "auto"
                    ? "auto-pay, PayPal"
                    : order.paidVia === "saved"
                      ? "saved PayPal"
                      : order.paidVia === "invoice"
                        ? "PayPal invoice"
                        : "with PayPal"}
              </span>
            </span>
            {order.status === "paid" && !order.shipsWithOrderNumber && !shipping && (
              <button
                type="button"
                onClick={() => setShipping(true)}
                className="shrink-0 rounded-full border-2 border-white bg-sticker px-3 py-0.5 text-[13px] font-bold text-black"
              >
                Ship
              </button>
            )}
          </div>
        </>
      )}
    </article>
  );
}

/** Post the parcel: carrier and tracking number go to PayPal with the payment. */
function ShipForm({
  order,
  token,
  onDone,
}: {
  order: OrderDTO;
  token: string;
  onDone: () => void;
}) {
  const [carrier, setCarrier] = useState<string>("singpost");
  const [carrierName, setCarrierName] = useState("");
  const [tracking, setTracking] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.shipOrder(
        order.id,
        { carrier, trackingNumber: tracking, ...(carrier === "other" ? { carrierName } : {}) },
        token,
      );
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const field = "w-full rounded-full border-2 border-black bg-label px-3 py-1.5 text-sm";
  return (
    <form onSubmit={submit} className="mt-2 flex flex-col gap-2 border-t border-line pt-2">
      <select
        value={carrier}
        onChange={(e) => setCarrier(e.target.value)}
        aria-label="Carrier"
        className={field}
      >
        {CARRIERS.map((c) => (
          <option key={c.key} value={c.key}>
            {c.label}
          </option>
        ))}
      </select>
      {carrier === "other" && (
        <input
          value={carrierName}
          onChange={(e) => setCarrierName(e.target.value)}
          placeholder="Carrier name"
          aria-label="Carrier name"
          className={field}
        />
      )}
      <input
        required
        value={tracking}
        onChange={(e) => setTracking(e.target.value)}
        placeholder="Tracking number"
        aria-label="Tracking number"
        className={field}
      />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="flex-1 rounded-full bg-black px-3.5 py-1.5 text-sm font-bold text-white disabled:opacity-50"
        >
          {busy ? "Sending to PayPal…" : "Mark shipped"}
        </button>
        <button type="button" onClick={onDone} className="px-2 text-sm text-quiet">
          Cancel
        </button>
      </div>
      {error && <span className="text-sm text-pen">{error}</span>}
    </form>
  );
}

/** Once the live is over: invoices go out, then the night's notes, at the top of the table. */
function AfterLive({ sessionId, token }: { sessionId: string; token: string }) {
  const recapVersion = useLive((s) => s.recapVersion);
  const [recap, setRecap] = useState<RecapDTO | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the recap is written
  useEffect(() => {
    api.recap(sessionId, token).then(
      (r) => setRecap(r.recap),
      () => undefined,
    );
  }, [sessionId, token, recapVersion]);

  return (
    <section className="label mb-4" aria-label="After the live">
      <div className="zone flex items-baseline justify-between gap-3 px-4 py-2.5">
        <h2 className="text-sm font-extrabold text-pen">After the live</h2>
        {recap && (
          <span className="text-xs text-quiet">{recap.byAi ? "Written by PlusOne" : ""}</span>
        )}
      </div>
      {recap ? (
        <div className="zone px-4 py-3">
          <p className="sort text-[30px]">{recap.headline}</p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {recap.notes.map((n) => (
              <li key={n} className="flex gap-2 leading-snug">
                <span className="font-bold text-pen">–</span>
                <span>{n}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="zone px-4 py-3 text-quiet">
          Closing out: sending PayPal invoices to anyone who still owes, then a note on tonight…
        </p>
      )}
    </section>
  );
}

function WaitingCard({ entry }: { entry: WaitingDTO }) {
  const place =
    ["", "next in line", "2nd in line", "3rd in line"][entry.position] ??
    `${entry.position}th in line`;
  return (
    <div className="rounded-label border-2 border-dashed border-black bg-label/55 px-3 py-2.5 text-[13px]">
      <b className="block text-sm font-extrabold">
        In line: {entry.buyerName} <span className="font-semibold text-quiet">({place})</span>
      </b>
      {entry.item}
      {entry.condition && <span className="text-quiet"> ({entry.condition})</span>}. Gets it if a
      hold runs out.
    </div>
  );
}

function CameraPanel({ camera }: { camera: ReturnType<typeof useHostCamera> }) {
  return (
    <div className="shrink-0">
      <div className="relative aspect-[16/10] overflow-hidden rounded-label border-2 border-black bg-stage">
        {camera.preview ? (
          <TrackVideo track={camera.preview} mirror className="h-full w-full object-cover" />
        ) : (
          <p className="flex h-full items-center justify-center px-6 text-center text-sm text-white/60">
            {camera.state === "error"
              ? `Camera didn't start: ${camera.error}`
              : "Buyers see your camera here once you go live."}
          </p>
        )}
        {camera.state === "live" && (
          <span className="absolute top-2 left-2 rounded-full bg-black/60 px-2.5 py-1 text-xs text-white tabular">
            {camera.viewers} watching
          </span>
        )}
      </div>
      {camera.state === "live" ? (
        <button
          type="button"
          onClick={() => void camera.stop()}
          className="mt-3 w-full rounded-full border-2 border-black py-2.5 text-sm font-bold"
        >
          Turn camera off
        </button>
      ) : (
        <button
          type="button"
          disabled={camera.state === "starting"}
          onClick={() => void camera.start()}
          className="mt-3 w-full rounded-full bg-pen py-2.5 text-sm font-bold text-white disabled:opacity-60"
        >
          {camera.state === "starting" ? "Starting camera…" : "Go live with camera"}
        </button>
      )}
    </div>
  );
}

function ProductList({
  products,
  currentId,
  sessionId,
  token,
}: {
  products: ProductDTO[];
  currentId: string | null;
  sessionId: string;
  token: string;
}) {
  return (
    <div>
      <p className="mt-1 mb-1.5 text-xs text-quiet">
        Tap a product or press its number to put it on screen.
      </p>
      <ul className="flex flex-col gap-0.5">
        {products.map((p, i) => {
          const on = p.id === currentId;
          const t = p.variants.reduce(
            (s, v) => ({ left: s.left + v.available, held: s.held + v.reserved }),
            { left: 0, held: 0 },
          );
          const colors = [
            ...new Set(p.variants.map((v) => v.color).filter((c): c is string => Boolean(c))),
          ];
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => void api.showcase(sessionId, p.id, token)}
                aria-pressed={on}
                className={`grid w-full grid-cols-[18px_30px_1fr_auto] items-center gap-2 rounded-lg px-1.5 py-1.5 text-left ${on ? "bg-pale" : "hover:bg-paper"}`}
              >
                <span className="sort text-center text-[20px]">{i < 9 ? i + 1 : ""}</span>
                <span className="h-[30px] w-[30px] rounded-[7px]" style={productSwatch(colors)} />
                <span className="min-w-0">
                  <b className="block truncate text-[13px] leading-tight font-bold">{p.name}</b>
                  <small className="text-xs text-quiet">
                    {on ? "on screen, " : ""}
                    {t.held} held
                  </small>
                </span>
                <span className="sort text-[20px]" title={`${t.left} left`}>
                  {t.left}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SellerLogin({ onToken }: { onToken: (t: string) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [demoPassword, setDemoPassword] = useState<string | null>(null);

  useEffect(() => {
    api.config().then(
      (c) => setDemoPassword(c.demo?.sellerPassword ?? null),
      () => undefined,
    );
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      onToken((await api.sellerLogin(password)).token);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="kraft flex h-full items-start justify-center px-4 pt-28">
      <form onSubmit={submit} className="label w-full max-w-sm">
        <div className="zone px-5 py-4">
          <small className="text-xs font-semibold text-quiet">Seller console</small>
          <h1 className="text-[26px] leading-tight font-extrabold">Tonight's orders</h1>
        </div>
        <div className="zone flex flex-col gap-3 px-5 py-4">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Seller password"
            aria-label="Password"
            className="rounded-full border-2 border-black bg-label px-4 py-2.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-black"
          />
          <button type="submit" className="rounded-full bg-black py-2.5 font-bold text-white">
            Open console
          </button>
          {error && <p className="text-sm text-pen">{error}</p>}
        </div>
        {demoPassword && (
          <p className="zone bg-pale px-5 py-3 text-sm leading-snug">
            Trying the demo? The password is{" "}
            <button
              type="button"
              onClick={() => setPassword(demoPassword)}
              className="font-bold underline decoration-dotted underline-offset-2"
            >
              {demoPassword}
            </button>
          </p>
        )}
      </form>
    </div>
  );
}
