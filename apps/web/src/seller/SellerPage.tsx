import {
  formatMoney,
  type OrderDTO,
  type ProductDTO,
  type RecapDTO,
  type WaitingDTO,
} from "@plusone/shared";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useHostSpeech } from "../lib/speech";
import { readStored, SELLER_TOKEN_KEY, writeStored } from "../lib/storage";
import { productSwatch } from "../lib/swatch";
import { useLive, useLiveRoom } from "../lib/useLiveRoom";
import { TrackVideo, useHostCamera } from "../lib/video";
import { ChatFeed } from "../live/Chat";
import { dueLabel, sortNumber } from "../live/OrderSlip";
import { ConsoleTabs } from "./ConsoleTabs";
import { Copilot } from "./Copilot";
import { Helpers } from "./Helpers";
import { useWatch } from "./HostEyes";
import { VoiceCards } from "./HostVoice";
import { NeedsYou } from "./NeedsYou";

// The host's screen during a live. Tonight's orders are three manifests on the
// table: waiting for money, paid and ready to pack, sent, one line per order.
// What only the seller can decide comes on red tape across the top, and Ask
// PlusOne sits at the bottom. Camera, helpers and products on the left; the
// chat opens beside the table only when the seller wants to read it.

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
  const [chatOpen, setChatOpen] = useState(false);
  const [seen, setSeen] = useState(0);
  const camera = useHostCamera(session?.id ?? null, token);
  const speech = useHostSpeech({ hostListen, hostAudio }, camera.mic);
  const watch = useWatch(session?.id ?? "", token, camera.preview);

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

  // While the chat is open everything in it counts as read.
  useEffect(() => {
    if (chatOpen) setSeen(messages.length);
  }, [chatOpen, messages.length]);

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
  const live = session.status !== "ended";

  async function endLive() {
    if (!session) return;
    const ok = window.confirm(
      "End the live? Anyone still holding unpaid items gets a PayPal invoice and keeps their items until tomorrow.",
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
        ended={!live}
        chat={{
          open: chatOpen,
          unread: Math.max(0, messages.length - seen),
          onToggle: () => setChatOpen((v) => !v),
        }}
      >
        <Stat value={money(taken)} label="paid" paid />
        <Stat value={money(owed)} label="waiting" />
        {live && (
          <button
            type="button"
            disabled={busy}
            onClick={endLive}
            className="rounded-full border-2 border-black px-3.5 py-1.5 text-sm font-bold disabled:opacity-50"
          >
            End live
          </button>
        )}
        <DemoMenu>
          {demo && live && (
            <button
              type="button"
              disabled={crowd === "playing"}
              onClick={() => void playCrowd()}
              className="w-full rounded-md px-3 py-2 text-left font-semibold hover:bg-paper disabled:opacity-60"
              title="Ten buyers talk the way they do in a real live; PlusOne handles them"
            >
              {crowd === "playing" ? "Buyers are chatting…" : "Play a busy minute"}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={reset}
            className="w-full rounded-md px-3 py-2 text-left font-semibold hover:bg-paper"
          >
            Reset demo
          </button>
        </DemoMenu>
      </ConsoleTabs>

      <div
        className={`grid min-h-0 flex-1 grid-cols-1 ${chatOpen ? "lg:grid-cols-[280px_minmax(0,1fr)_320px]" : "lg:grid-cols-[280px_minmax(0,1fr)]"}`}
      >
        <aside
          className="flex flex-col gap-3 overflow-y-auto border-r-2 border-black bg-label p-4"
          aria-label="Camera and products"
        >
          <CameraPanel camera={camera} ended={!live} />
          <Helpers speech={speech} watch={watch} cameraOn={camera.state === "live"} />
          <ProductList
            products={session.products}
            currentId={session.currentProductId}
            sessionId={session.id}
            token={token}
          />
        </aside>

        <main
          className="kraft relative flex min-h-0 flex-col overflow-y-auto"
          aria-label="Tonight's order book"
        >
          <div className="flex-1 p-6">
            {!live && <AfterLive sessionId={session.id} token={token} />}
            <NeedsYou sessionId={session.id} token={token} />
            <VoiceCards sessionId={session.id} token={token} />
            <div
              className={`grid items-start gap-5 ${chatOpen ? "xl:grid-cols-2" : "xl:grid-cols-3"}`}
            >
              <Manifest title="Waiting to pay" count={owing.length}>
                {owing.map((o, i) => (
                  <OwingRow key={o.id} order={o} token={token} first={i === 0} />
                ))}
                {owing.length === 0 && waiting.length === 0 && (
                  <Quiet>Orders land here as buyers say +1.</Quiet>
                )}
                {waiting.length > 0 && <InLine entries={waiting} />}
                {cancelled.length > 0 && (
                  <Quiet>
                    {cancelled.length} cancelled ({cancelled.map((o) => o.buyer.name).join(", ")}),
                    back on sale.
                  </Quiet>
                )}
              </Manifest>
              <Manifest title="Paid, pack it" count={paid.length}>
                {paid.map((o, i) => (
                  <PaidRow key={o.id} order={o} token={token} first={i === 0} />
                ))}
                {paid.length === 0 && <Quiet>Paid orders land here, ready to pack.</Quiet>}
              </Manifest>
              <Manifest title="Sent" count={sent.length}>
                {sent.map((o, i) => (
                  <SentRow key={o.id} order={o} first={i === 0} />
                ))}
                {sent.length === 0 && <Quiet>Nothing sent yet.</Quiet>}
              </Manifest>
            </div>
          </div>
          <div className="sticky bottom-0 px-6 pt-2 pb-5">
            <Copilot sessionId={session.id} token={token} />
          </div>
        </main>

        {chatOpen && (
          <aside
            className="overflow-y-auto border-l-2 border-black bg-label px-4 py-4 text-sm"
            aria-label="Chat"
          >
            <ChatFeed messages={messages} thinking={thinking} myBuyerId={null} variant="panel" />
          </aside>
        )}
      </div>
    </div>
  );
}

function Stat({ value, label, paid = false }: { value: string; label: string; paid?: boolean }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <b className={`sort text-[26px] ${paid ? "text-paid" : ""}`}>{value}</b>
      <span className="text-[13px] text-quiet">{label}</span>
    </span>
  );
}

/** Demo-only actions, out of the way of the real ones. Closes after a pick or a click elsewhere. */
function DemoMenu({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current?.open && !ref.current.querySelector("summary")?.contains(e.target as Node))
        ref.current.open = false;
    };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);
  return (
    <details ref={ref} className="relative">
      <summary className="cursor-pointer list-none text-[13px] text-quiet hover:text-black">
        Demo ▾
      </summary>
      <div className="absolute top-8 right-0 z-30 flex w-52 flex-col rounded-[10px] border-2 border-black bg-label p-1.5 text-sm shadow-xl">
        {children}
      </div>
    </details>
  );
}

/** One lane of the night as a manifest: a label with one line per order. */
function Manifest({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="label">
      <div className="zone flex items-center justify-between px-4 py-2.5">
        <h2 className="text-base font-bold">{title}</h2>
        <b className={`sort text-[28px] ${count === 0 ? "text-black/30" : ""}`}>{count}</b>
      </div>
      <div className="zone px-4">{children}</div>
    </section>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="py-3 text-sm text-quiet">{children}</p>;
}

const itemsOf = (order: OrderDTO, statuses: string[]) =>
  order.lines
    .filter((l) => statuses.includes(l.status))
    .map((l) => {
      const option = [l.color, l.size].filter(Boolean).join(" ");
      return `${l.productName}${option ? `, ${option}` : ""}${l.qty > 1 ? ` x${l.qty}` : ""}`;
    })
    .join("; ");

function Row({
  order,
  first,
  items,
  right,
  children,
}: {
  order: OrderDTO;
  first: boolean;
  items: string;
  right: ReactNode;
  children?: ReactNode;
}) {
  return (
    <article
      aria-label={`Order ${order.number}, ${order.buyer.name}`}
      className={`group py-2.5 ${first ? "" : "border-t border-line"}`}
    >
      <div className="flex items-center gap-3">
        <b className="sort w-8 shrink-0 text-[22px]">{sortNumber(order.number)}</b>
        <div className="min-w-0 flex-1">
          <p className="truncate font-bold">{order.buyer.name}</p>
          <p className="truncate text-[13px] text-quiet" title={items}>
            {items}
          </p>
        </div>
        <div className="shrink-0 text-right">{right}</div>
      </div>
      {children}
    </article>
  );
}

function OwingRow({ order, token, first }: { order: OrderDTO; token: string; first: boolean }) {
  const now = useNow(5_000);
  const [note, setNote] = useState<string | null>(null);
  const invoice = order.invoice?.status === "sent" ? order.invoice : null;
  const left = order.holdExpiresAt ? Date.parse(order.holdExpiresAt) - now : 0;
  const minutes = Math.ceil(left / 60_000);

  async function remind() {
    try {
      const r = await api.remind(order.sessionId, order.number, token);
      setNote(`reminded, ${r.minutesLeft} min`);
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Row
      order={order}
      first={first}
      items={itemsOf(order, ["held"])}
      right={
        <>
          <b className="block text-sm tabular">
            {formatMoney(order.totalCents, order.currency).replace(".00", "")}
          </b>
          {note ? (
            <span className="text-xs text-quiet">{note}</span>
          ) : invoice ? (
            <span className="text-xs text-quiet" title="PayPal invoice sent">
              invoice due {dueLabel(invoice.dueAt)}
            </span>
          ) : order.autopayAt ? (
            <span className="text-xs font-semibold">auto-paying</span>
          ) : (
            <span className="flex items-center justify-end gap-2 text-xs">
              <button
                type="button"
                onClick={() => void remind()}
                className="font-semibold underline decoration-dotted underline-offset-2 opacity-0 group-hover:opacity-100 focus:opacity-100"
              >
                Remind
              </button>
              <span className={minutes <= 3 ? "font-bold text-pen" : "text-quiet"}>
                {left > 0 ? `${minutes} min` : "ending"}
              </span>
            </span>
          )}
        </>
      }
    />
  );
}

const PAID_VIA: Record<NonNullable<OrderDTO["paidVia"]>, string> = {
  checkout: "PayPal",
  saved: "saved PayPal",
  auto: "auto-pay",
  invoice: "PayPal invoice",
};

function PaidRow({ order, token, first }: { order: OrderDTO; token: string; first: boolean }) {
  const [shipping, setShipping] = useState(false);
  return (
    <Row
      order={order}
      first={first}
      items={itemsOf(order, ["paid"])}
      right={
        order.shipsWithOrderNumber ? (
          <span className="text-xs text-quiet">
            ships with #{sortNumber(order.shipsWithOrderNumber)}
          </span>
        ) : shipping ? null : (
          <>
            <button
              type="button"
              onClick={() => setShipping(true)}
              className="rounded-full border-2 border-black px-3 py-0.5 text-[13px] font-bold"
            >
              Ship
            </button>
            <span className="mt-0.5 block text-[11px] text-quiet">
              {PAID_VIA[order.paidVia ?? "checkout"]}
            </span>
          </>
        )
      }
    >
      {shipping && <ShipForm order={order} token={token} onDone={() => setShipping(false)} />}
    </Row>
  );
}

function SentRow({ order, first }: { order: OrderDTO; first: boolean }) {
  return (
    <Row
      order={order}
      first={first}
      items={itemsOf(order, ["paid"])}
      right={
        order.tracking ? (
          <span className="text-xs text-quiet">
            {order.tracking.carrier}
            <span className="block font-semibold text-black tabular">{order.tracking.number}</span>
          </span>
        ) : null
      }
    />
  );
}

/** People waiting for a sold-out item: they get it if a hold runs out. */
function InLine({ entries }: { entries: WaitingDTO[] }) {
  return (
    <div className="border-t border-line py-2.5">
      <p className="text-xs font-bold">In line if a hold runs out</p>
      {entries.map((e) => (
        <p key={e.id} className="mt-1 text-[13px]">
          <span className="font-semibold">{e.buyerName}</span>{" "}
          <span className="text-quiet">
            {e.item}
            {e.condition ? ` (${e.condition})` : ""}
            {e.position === 1 ? ", next" : `, #${e.position}`}
          </span>
        </p>
      ))}
    </div>
  );
}

const CARRIERS = [
  { key: "singpost", label: "SingPost" },
  { key: "ninjavan", label: "Ninja Van" },
  { key: "jt", label: "J&T Express" },
  { key: "dhl", label: "DHL" },
  { key: "other", label: "Other" },
] as const;

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

function CameraPanel({
  camera,
  ended,
}: {
  camera: ReturnType<typeof useHostCamera>;
  ended: boolean;
}) {
  return (
    <div className="shrink-0">
      <div className="relative aspect-[16/10] overflow-hidden rounded-label border-2 border-black bg-stage">
        {camera.preview ? (
          <TrackVideo track={camera.preview} mirror className="h-full w-full object-cover" />
        ) : (
          <p className="flex h-full items-center justify-center px-6 text-center text-sm text-white/60">
            {ended
              ? "The live has ended."
              : camera.state === "error"
                ? `Camera didn't start: ${camera.error}`
                : "Buyers see your camera here once you go live."}
          </p>
        )}
        {camera.state === "live" && (
          <>
            <span className="absolute top-2 left-2 rounded-full bg-black/60 px-2.5 py-1 text-xs text-white tabular">
              {camera.viewers} watching
            </span>
            <button
              type="button"
              onClick={() => void camera.stop()}
              className="absolute right-2 bottom-2 rounded-full bg-white px-2.5 py-1 text-xs font-bold"
            >
              Turn camera off
            </button>
          </>
        )}
      </div>
      {camera.state !== "live" && !ended && (
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
    <ul className="flex flex-col" title="Tap a product or press its number to put it on screen">
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
              className={`grid w-full grid-cols-[18px_26px_1fr_auto] items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left ${on ? "bg-pale" : "hover:bg-paper"}`}
            >
              <span className="sort text-center text-[20px]">{i < 9 ? i + 1 : ""}</span>
              <span className="h-6.5 w-6.5 rounded-md" style={productSwatch(colors)} />
              <span className={`truncate text-sm ${on ? "font-bold" : ""}`}>{p.name}</span>
              <span className="sort text-[20px]" title={`${t.left} left, ${t.held} held`}>
                {t.left}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
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
