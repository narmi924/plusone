import {
  formatMoney,
  type OrderDTO,
  type ProductDTO,
  type RecapDTO,
  type WaitingDTO,
} from "@plusone/shared";
import { type CSSProperties, type FormEvent, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useHostSpeech } from "../lib/speech";
import { readStored, SELLER_TOKEN_KEY, writeStored } from "../lib/storage";
import { useLive, useLiveRoom } from "../lib/useLiveRoom";
import { TrackVideo, useHostCamera } from "../lib/video";
import { ChatFeed } from "../live/Chat";
import { dueLabel } from "../live/OrderSlip";
import { ConsoleTabs } from "./ConsoleTabs";
import { VoiceCards, VoiceControl } from "./HostVoice";
import { NeedsYou } from "./NeedsYou";

// The host's screen during a live. In the middle is tonight's order book, which
// PlusOne writes as the chat happens: held items highlighted, paid ones ticked
// and stamped, changes struck through, people waiting pencilled in, anything
// that needs the seller in red pen. Camera, voice and products on the left;
// the whole chat, including PlusOne's private replies, on the right.

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

const BOOK: CSSProperties & Record<"--rule-h" | "--margin-x", string> = {
  "--rule-h": "40px",
  "--margin-x": "64px",
};

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
  const camera = useHostCamera(session?.id ?? null, token);
  const speech = useHostSpeech({ hostListen, hostAudio }, camera.mic);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when someone joins or leaves a line, or orders move
  useEffect(() => {
    if (session?.id) api.waitlist(session.id, token).then(setWaiting, () => undefined);
  }, [session?.id, token, waitlistVersion, orders]);

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
  if (!session) return <p className="p-8 text-quiet">Opening tonight's book…</p>;

  const paid = orders.filter((o) => o.status === "paid" || o.status === "shipped");
  const held = orders.filter((o) => o.status === "reserved");
  const takings = paid.reduce((n, o) => n + o.totalCents, 0);
  const book = [...orders].sort((a, b) => a.number - b.number);

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
    <div className="flex h-full flex-col bg-white">
      <ConsoleTabs
        sellerName={session.seller.name}
        current="book"
        ended={session.status === "ended"}
      >
        <span>
          <b className="text-xl font-extrabold">{held.length}</b>{" "}
          <span className="text-quiet">waiting to pay</span>
        </span>
        <span>
          <b className="text-xl font-extrabold text-paid">{paid.length}</b>{" "}
          <span className="text-quiet">paid</span>
        </span>
        <span>
          <b className="text-xl font-extrabold">
            {formatMoney(takings, session.seller.currency).replace(".00", "")}
          </b>{" "}
          <span className="text-quiet">taken</span>
        </span>
        {session.status !== "ended" && (
          <button
            type="button"
            disabled={busy}
            onClick={endLive}
            className="rounded-full border-[1.5px] border-black px-3 py-1.5 text-sm font-bold disabled:opacity-50"
          >
            End live
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

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)_340px]">
        <aside
          className="flex flex-col gap-3 overflow-y-auto border-r border-line p-4"
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

        <main
          className="book overflow-y-auto pt-5 pr-8 pb-10 pl-21"
          style={BOOK}
          aria-label="Tonight's order book"
        >
          <p className="font-hand text-[22px] leading-(--rule-h)">
            <span className="font-bold text-pen">
              {new Date()
                .toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "numeric" })
                .replace(",", "")}
            </span>
            <span className="ml-3 text-ink">{session.title}</span>
          </p>
          <VoiceCards sessionId={session.id} token={token} />
          <NeedsYou sessionId={session.id} token={token} />
          <div className="clear-both" />
          {book.length === 0 && waiting.length === 0 ? (
            <p className="font-hand text-[21px] leading-(--rule-h) text-quiet">
              Empty page. Orders get written here as buyers say +1.
            </p>
          ) : (
            <ol>
              {book.map((o) => (
                <OrderLine key={o.id} order={o} token={token} />
              ))}
              {waiting.map((w) => (
                <WaitingLine key={w.id} entry={w} />
              ))}
            </ol>
          )}
          {session.status === "ended" && <AfterLive sessionId={session.id} token={token} />}
        </main>

        <aside
          className="overflow-y-auto border-l border-line px-4.5 py-4 text-sm"
          aria-label="Chat"
        >
          <ChatFeed messages={messages} thinking={thinking} myBuyerId={null} variant="panel" />
        </aside>
      </div>
    </div>
  );
}

const clock = (iso: string) =>
  new Date(iso)
    .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    .toLowerCase()
    .replace(" ", "");

const CARRIERS = [
  { key: "singpost", label: "SingPost" },
  { key: "ninjavan", label: "Ninja Van" },
  { key: "jt", label: "J&T Express" },
  { key: "dhl", label: "DHL" },
  { key: "other", label: "Other" },
] as const;

function OrderLine({ order, token }: { order: OrderDTO; token: string }) {
  const refunded = order.lines.some((l) => l.status === "refunded");
  const [shipping, setShipping] = useState(false);
  const paid = order.status === "paid";
  return (
    <li className="relative grid min-h-(--rule-h) grid-cols-[120px_minmax(0,1fr)_96px_150px] items-baseline">
      <span className="absolute -left-18 w-12 text-right font-hand text-lg leading-(--rule-h) font-bold text-pen">
        {order.number}
      </span>
      <span className="truncate text-[15px] leading-(--rule-h) font-bold">{order.buyer.name}</span>
      <span className="font-hand text-[21px] leading-(--rule-h) text-ink">
        {order.lines.map((l, i) => {
          const option = [l.color, l.size].filter(Boolean).join(" ");
          const text = `${l.productName}${option ? `, ${option}` : ""}${l.qty > 1 ? ` x${l.qty}` : ""}`;
          const style = l.status === "held" ? "highlight" : l.status === "paid" ? "" : "struck";
          return (
            <span key={l.id}>
              <span className={style}>{text}</span>
              {i < order.lines.length - 1 && <span className="text-quiet">; </span>}
            </span>
          );
        })}
      </span>
      <span className="text-right font-hand text-[21px] leading-(--rule-h) text-ink tabular">
        {order.totalCents > 0 ? (order.totalCents / 100).toFixed(2) : ""}
      </span>
      <span className="text-right text-[13px] leading-(--rule-h) font-bold">
        {paid || order.status === "shipped" ? (
          <>
            {paid && !order.shipsWithOrderNumber && !shipping && (
              <button
                type="button"
                onClick={() => setShipping(true)}
                className="mr-2 rounded-full border-[1.5px] border-black px-2.5 py-1 text-xs font-bold"
              >
                Ship
              </button>
            )}
            <span className="mr-1.5 font-hand text-[22px] text-paid">✓</span>
            <span className="stamp">{order.status === "shipped" ? "SHIPPED" : "PAID"}</span>
          </>
        ) : order.status === "reserved" && order.invoice?.status === "sent" ? (
          <span className="tabular" title="PayPal invoice sent; items held until it's due">
            <span className="mr-1 font-medium text-quiet">invoiced</span>
            <span className="rounded bg-sticker px-1.5 py-1">
              due {dueLabel(order.invoice.dueAt)}
            </span>
          </span>
        ) : order.status === "reserved" ? (
          <span className="rounded bg-sticker px-1.5 py-1 tabular">
            {order.holdExpiresAt ? clock(order.holdExpiresAt) : "held"}
          </span>
        ) : (
          <span className="font-medium text-quiet">{refunded ? "refunded" : "cancelled"}</span>
        )}
      </span>
      {(order.shipsWithOrderNumber || order.tracking || (paid && order.shipTo)) && (
        <span className="col-span-3 col-start-2 -mt-2 pb-1 text-xs text-quiet">
          {order.shipsWithOrderNumber && (
            <span className="mr-3">ships in one parcel with #{order.shipsWithOrderNumber}</span>
          )}
          {order.tracking ? (
            <span>
              {order.tracking.carrier} {order.tracking.number}
            </span>
          ) : (
            order.shipTo && <span>to {order.shipTo}</span>
          )}
        </span>
      )}
      {shipping && <ShipForm order={order} token={token} onDone={() => setShipping(false)} />}
    </li>
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

  const field = "rounded-full border-[1.5px] border-black bg-white px-3 py-1.5 text-sm";
  return (
    <form
      onSubmit={submit}
      className="col-span-3 col-start-2 flex flex-wrap items-center gap-2 py-1.5"
    >
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
          className={`${field} w-36`}
        />
      )}
      <input
        required
        value={tracking}
        onChange={(e) => setTracking(e.target.value)}
        placeholder="Tracking number"
        aria-label="Tracking number"
        className={`${field} w-52`}
      />
      <button
        type="submit"
        disabled={busy}
        className="rounded-full bg-black px-3.5 py-1.5 text-sm font-bold text-white disabled:opacity-50"
      >
        {busy ? "Sending to PayPal…" : "Mark shipped"}
      </button>
      <button type="button" onClick={onDone} className="px-2 text-sm text-quiet">
        Cancel
      </button>
      {error && <span className="w-full font-hand text-lg text-pen">{error}</span>}
    </form>
  );
}

/** The bottom of the page once the live is over: invoices go out, then the night's notes. */
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
    <section className="mt-(--rule-h)" aria-label="After the live">
      <h2 className="font-hand text-[22px] leading-(--rule-h) font-bold text-pen">
        After the live
      </h2>
      {recap ? (
        <div className="font-hand text-[21px] leading-(--rule-h) text-ink">
          <p className="font-bold">{recap.headline}</p>
          <ul>
            {recap.notes.map((n) => (
              <li key={n} className="flex gap-2">
                <span className="text-pen">–</span>
                <span>{n}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="font-hand text-[21px] leading-(--rule-h) text-quiet">
          Closing out: sending PayPal invoices to anyone who still owes, then a note on tonight…
        </p>
      )}
    </section>
  );
}

function WaitingLine({ entry }: { entry: WaitingDTO }) {
  const place =
    ["", "next in line", "2nd in line", "3rd in line"][entry.position] ??
    `${entry.position}th in line`;
  return (
    <li className="grid min-h-(--rule-h) grid-cols-[120px_minmax(0,1fr)_96px_140px] items-baseline">
      <span className="truncate text-[15px] leading-(--rule-h) font-bold">{entry.buyerName}</span>
      <span className="truncate font-hand text-[21px] leading-(--rule-h) text-quiet">
        waiting for {entry.item}
        {entry.condition && <span className="ml-2 text-base">({entry.condition})</span>}
      </span>
      <span />
      <span className="text-right text-[13px] leading-(--rule-h) font-medium text-quiet">
        {place}
      </span>
    </li>
  );
}

function CameraPanel({ camera }: { camera: ReturnType<typeof useHostCamera> }) {
  return (
    <div className="shrink-0">
      <div className="relative aspect-[16/10] overflow-hidden rounded-[10px] bg-stage">
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
          className="mt-3 w-full rounded-full border-[1.5px] border-black py-2.5 text-sm font-bold"
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
      <p className="mt-1 mb-1 text-xs text-quiet">
        Tap a product or press its number to put it on screen.
      </p>
      <ul>
        {products.map((p, i) => {
          const on = p.id === currentId;
          const t = p.variants.reduce(
            (s, v) => ({
              left: s.left + v.available,
              held: s.held + v.reserved,
              sold: s.sold + v.sold,
            }),
            { left: 0, held: 0, sold: 0 },
          );
          return (
            <li key={p.id} className="border-t border-line">
              <button
                type="button"
                onClick={() => void api.showcase(sessionId, p.id, token)}
                aria-pressed={on}
                className="grid w-full grid-cols-[22px_1fr] gap-x-2 py-2.5 text-left hover:bg-paper"
              >
                <kbd
                  className={`h-5 rounded text-center font-sans text-xs leading-5 font-bold text-white ${on ? "bg-pen" : "bg-black"}`}
                >
                  {i < 9 ? i + 1 : ""}
                </kbd>
                <span className="text-sm leading-5 font-bold">
                  {p.code} {p.name}
                  {on && <span className="ml-2 text-[11px] text-pen">on screen</span>}
                </span>
                <small className="col-start-2 text-xs text-quiet tabular">
                  {t.left} left, {t.held} held, {t.sold} sold
                </small>
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
    <div className="book flex h-full items-start justify-center pt-32" style={BOOK}>
      <form onSubmit={submit} className="flex w-80 flex-col gap-3">
        <h1 className="font-hand text-3xl font-bold text-ink">Tonight's order book</h1>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Seller password"
          aria-label="Password"
          className="rounded-full border-[1.5px] border-black bg-white px-4 py-2.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink"
        />
        <button type="submit" className="rounded-full bg-black py-2.5 font-bold text-white">
          Open console
        </button>
        {error && <p className="font-hand text-lg text-pen">{error}</p>}
        {demoPassword && (
          <p className="font-hand text-lg leading-snug text-pen">
            Trying the demo? The password is{" "}
            <button
              type="button"
              onClick={() => setPassword(demoPassword)}
              className="rounded bg-white px-1.5 font-sans text-sm text-black underline decoration-dotted underline-offset-2"
            >
              {demoPassword}
            </button>
          </p>
        )}
      </form>
    </div>
  );
}
