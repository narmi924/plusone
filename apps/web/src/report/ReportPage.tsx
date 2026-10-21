import type { WaitingDTO } from "@plusone/shared";
import { type AgDataSourcesDefinition, AgStudioAiModule, type AgStudioModule } from "ag-studio";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router";
import { api } from "../lib/api";
import { readStored, SELLER_TOKEN_KEY } from "../lib/storage";
import { useLive, useLiveRoom } from "../lib/useLiveRoom";
import { ConsoleTabs } from "../seller/ConsoleTabs";
import { reportAi, reportAuth } from "./ai";
import { reportData, toLineRows, toStockRows } from "./data";
import { initialReport } from "./report";
import { reportTheme } from "./theme";
import { reportWidgets } from "./widgets";

// The seller's report (AG Studio): tonight's money, stock and every order
// line, live, plus an assistant that answers questions about them and can
// nudge buyers who still owe. Loaded only when opened: Studio is large.

// Studio compares props by reference on every render: keep these stable.
const MODULES: AgStudioModule[] = [AgStudioAiModule];
const PANELS = { edit: { right: ["ai" as const] }, view: { right: ["filters" as const] } };
const STYLE = { height: "100%", width: "100%" };
const LICENSE = import.meta.env.VITE_AG_STUDIO_LICENSE as string | undefined;

export default function ReportPage() {
  const token = readStored(SELLER_TOKEN_KEY);
  if (!token) return <Navigate to="/seller" replace />;
  return <Report token={token} />;
}

function Report({ token }: { token: string }) {
  const { error } = useLiveRoom({ handle: "lumicloset", sellerToken: token });
  const session = useLive((s) => s.session);
  const orders = useLive((s) => s.orders);
  const waitlistVersion = useLive((s) => s.waitlistVersion);
  const [waiting, setWaiting] = useState<WaitingDTO[]>([]);
  // Null until the first real data arrives: Studio mounts with something to show.
  const [data, setData] = useState<AgDataSourcesDefinition | null>(null);

  reportAuth.token = token;
  reportAuth.sessionId = session?.id ?? "";

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the line changes or orders move
  useEffect(() => {
    if (session?.id) api.waitlist(session.id, token).then(setWaiting, () => undefined);
  }, [session?.id, token, waitlistVersion, orders]);

  // Live: every order or stock change rebuilds the data (coalesced, since each
  // new object makes Studio re-run every widget's query).
  useEffect(() => {
    const id = setTimeout(
      () => setData(reportData(toLineRows(orders), toStockRows(session?.products ?? [], waiting))),
      250,
    );
    return () => clearTimeout(id);
  }, [orders, session?.products, waiting]);

  if (error) return <p className="p-8 text-quiet">The report couldn't load: {error}</p>;
  if (!session || !data) return <p className="p-8 text-quiet">Opening the report…</p>;

  return (
    <div className="flex h-full flex-col bg-label">
      <ConsoleTabs
        sellerName={session.seller.name}
        current="report"
        ended={session.status === "ended"}
      />
      {orders.length === 0 ? (
        <div className="kraft flex flex-1 items-start justify-center px-4 pt-24">
          <div className="label w-full max-w-md">
            <p className="zone px-5 py-4 text-[17px] leading-snug font-bold">
              Nothing ordered yet tonight. The report fills in as buyers say +1.
            </p>
            <div className="zone px-5 py-3">
              <Link to="/seller" className="text-sm font-bold underline">
                Back to tonight's book
              </Link>
            </div>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <AgStudioProvider modules={MODULES} {...(LICENSE ? { licenseKey: LICENSE } : {})}>
            <AgStudio
              style={STYLE}
              theme={reportTheme}
              data={data}
              initialState={initialReport}
              widgets={reportWidgets}
              panels={PANELS}
              ai={reportAi}
              mode="edit"
            />
          </AgStudioProvider>
        </div>
      )}
    </div>
  );
}
