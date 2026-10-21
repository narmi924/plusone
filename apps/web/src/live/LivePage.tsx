import { PayPalProvider } from "@paypal/react-paypal-js/sdk-v6";
import type { BuyerDTO, PublicConfig } from "@plusone/shared";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import { api } from "../lib/api";
import { recentClaims } from "../lib/claims";
import { BUYER_TOKEN_KEY, readStored, writeStored } from "../lib/storage";
import { useLive, useLiveRoom } from "../lib/useLiveRoom";
import { TrackAudio, TrackVideo, useWatchLive } from "../lib/video";
import { ChatFeed, ChatInput, PinnedHowTo } from "./Chat";
import { MyOrderBar, OrderPanel } from "./OrderSlip";
import { Stage } from "./Stage";

export function LivePage() {
  const { handle = "lumicloset" } = useParams();
  const [token, setToken] = useState<string | null>(() => readStored(BUYER_TOKEN_KEY));
  const [buyer, setBuyer] = useState<BuyerDTO | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [draft, setDraft] = useState<{ text: string; n: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    api.config().then(setConfig, () => setConfig(null));
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!token) return setBuyer(null);
    api.me(token).then(setBuyer, () => {
      // Token from an old demo reset: start fresh.
      writeStored(BUYER_TOKEN_KEY, null);
      setToken(null);
    });
  }, [token]);

  const activeToken = buyer ? token : null;
  const { error, send } = useLiveRoom({ handle, buyerToken: activeToken });
  const session = useLive((s) => s.session);
  const messages = useLive((s) => s.messages);
  const orders = useLive((s) => s.orders);
  const thinking = useLive((s) => s.thinking);
  const connected = useLive((s) => s.connected);
  const watch = useWatchLive(session?.id ?? null, session?.hostVideoOn ?? false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: now ticks so old +1s fade out
  const claims = useMemo(
    () => recentClaims(messages, { limit: 3, withinMs: 60_000 }),
    [messages, now],
  );

  if (error) return <p className="p-8 text-quiet">This live couldn't be loaded: {error}</p>;
  if (!session) return <p className="p-8 text-quiet">Joining the live…</p>;

  const product = session.products.find((p) => p.id === session.currentProductId) ?? null;
  const paypalReady = Boolean(config?.paypalClientId);
  const addToChat = (text: string) => {
    setSheetOpen(false);
    setDraft((d) => ({ text, n: (d?.n ?? 0) + 1 }));
  };
  const book = (
    <OrderPanel
      session={session}
      orders={orders}
      buyerToken={activeToken}
      buyerName={buyer?.name ?? null}
      paypalReady={paypalReady}
      sandboxBuyer={config?.demo?.sandboxBuyer ?? null}
      onAdd={addToChat}
    />
  );

  const page = (
    <div className="grid h-full grid-cols-1 lg:grid-cols-[minmax(0,1fr)_420px]">
      <Stage
        product={product}
        currency={session.seller.currency}
        deals={session.deals}
        ended={session.status === "ended"}
        claims={claims}
        video={
          watch.video && <TrackVideo track={watch.video} className="h-full w-full object-cover" />
        }
        header={
          <div className="flex items-center gap-3">
            <span
              className={`rounded-[5px] px-2 py-1.5 text-[13px] leading-none font-extrabold [font-stretch:112%] ${session.status === "ended" ? "bg-quiet" : "bg-pen"}`}
            >
              {session.status === "ended" ? "ENDED" : "LIVE"}
            </span>
            <div className="min-w-0 rounded-xl bg-black/40 px-3 py-1.5">
              <h1 className="truncate text-[17px] leading-tight font-bold">
                {session.seller.name}
              </h1>
              <p className="hidden truncate text-[13px] text-white/80 sm:block">{session.title}</p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              {watch.audio && watch.soundBlocked && (
                <button
                  type="button"
                  onClick={watch.enableSound}
                  className="rounded-full bg-white px-3 py-1.5 text-[13px] font-bold text-black"
                >
                  Tap for sound
                </button>
              )}
              {watch.video && (
                <span className="rounded-full bg-black/45 px-2.5 py-1.5 text-[13px] tabular">
                  {watch.viewers} watching
                </span>
              )}
              <span
                className={`h-2 w-2 rounded-full ${connected ? "bg-paid" : "bg-white/40"}`}
                title={connected ? "Connected" : "Reconnecting"}
              />
            </div>
          </div>
        }
      >
        {session.status !== "ended" && (
          <PinnedHowTo shop={session.seller.name} {...(activeToken ? { onTry: addToChat } : {})} />
        )}
        {/* newest at the bottom; older lines fade out at the top */}
        <div className="flex max-h-[30vh] w-full sm:max-h-[34vh] max-w-136 flex-col justify-end overflow-hidden mask-[linear-gradient(to_bottom,transparent,black_20%)]">
          <ChatFeed
            messages={messages.slice(-40)}
            thinking={thinking}
            myBuyerId={buyer?.id ?? null}
            variant="overlay"
            onOption={activeToken ? (say) => void send(say) : undefined}
          />
        </div>
        {activeToken && (
          <MyOrderBar
            orders={orders}
            holdMinutes={session.seller.holdMinutes}
            onOpen={() => setSheetOpen(true)}
          />
        )}
        {session.status === "ended" ? (
          <p className="over-video py-2 text-center text-sm font-semibold">
            This live has ended. Thanks for watching!
          </p>
        ) : activeToken ? (
          <ChatInput onSend={send} draft={draft} />
        ) : (
          <JoinBar
            onJoined={(t, b) => {
              writeStored(BUYER_TOKEN_KEY, t);
              setToken(t);
              setBuyer(b);
            }}
          />
        )}
        {watch.audio && <TrackAudio track={watch.audio} />}
      </Stage>

      <aside
        className="kraft hidden overflow-y-auto border-l-2 border-black lg:block"
        aria-label="Your order"
      >
        {book}
      </aside>

      {sheetOpen && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/50 lg:hidden"
          role="dialog"
          aria-label="Your order"
        >
          <button
            type="button"
            className="h-24 shrink-0"
            aria-label="Close"
            onClick={() => setSheetOpen(false)}
          />
          <div className="kraft relative min-h-0 flex-1 overflow-y-auto rounded-t-[22px]">
            <div className="mx-auto mt-2.5 h-[5px] w-11 rounded-full bg-black/25" />
            <button
              type="button"
              onClick={() => setSheetOpen(false)}
              className="absolute top-3 right-3 z-10 rounded-full bg-black px-3 py-1.5 text-sm font-bold text-white"
            >
              Close
            </button>
            {book}
          </div>
        </div>
      )}
    </div>
  );

  if (!paypalReady || !config) return page;
  return (
    <PayPalProvider
      clientId={config.paypalClientId}
      environment={config.paypalEnv === "live" ? "production" : "sandbox"}
      components={["paypal-payments"]}
      pageType="checkout"
    >
      {page}
    </PayPalProvider>
  );
}

function JoinBar({ onJoined }: { onJoined: (token: string, buyer: BuyerDTO) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token, buyer } = await api.join(name, email);
      onJoined(token, buyer);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const field =
    "min-w-0 flex-1 rounded-full bg-white/95 px-4 py-3 text-[15px] text-black placeholder:text-quiet focus:outline-none focus-visible:ring-2 focus-visible:ring-sticker";
  return (
    <form onSubmit={submit}>
      <p className="over-video mb-2 text-sm text-white/90">
        Join to order. Your receipt goes to your email.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          aria-label="Your name"
          maxLength={40}
          className={field}
        />
        <input
          required
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          aria-label="Email"
          className={field}
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-full border-2 border-black bg-sticker px-6 py-3 font-extrabold text-black disabled:opacity-50"
        >
          Join
        </button>
      </div>
      {error && <p className="over-video mt-2 text-sm font-semibold text-sticker">{error}</p>}
    </form>
  );
}
