import type { ReactNode } from "react";
import { Link } from "react-router";

// The seller console's top bar: the live badge, the shop, and two views of
// tonight: the labels (while selling) and the report (the numbers).

export function ConsoleTabs({
  sellerName,
  current,
  ended = false,
  children,
}: {
  sellerName: string;
  current: "book" | "report";
  /** The live is over (unpaid holds were invoiced). */
  ended?: boolean;
  /** Stats and actions on the right. */
  children?: ReactNode;
}) {
  const tab = (to: string, label: string, active: boolean) => (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={`flex items-center px-1 text-sm font-bold ${
        active ? "text-black shadow-[inset_0_-4px_0_#000]" : "text-quiet hover:text-black"
      }`}
    >
      {label}
    </Link>
  );
  return (
    <header className="flex h-15 shrink-0 items-center gap-4 border-b-2 border-black bg-label px-6">
      <span
        className={`rounded-[5px] px-2 py-1.5 text-[13px] leading-none font-extrabold text-white [font-stretch:112%] ${ended ? "bg-quiet" : "bg-pen"}`}
      >
        {ended ? "ENDED" : "LIVE"}
      </span>
      <h1 className="text-lg font-extrabold">{sellerName}</h1>
      <nav className="ml-4 flex gap-5 self-stretch" aria-label="Console">
        {tab("/seller", "Tonight", current === "book")}
        {tab("/seller/report", "Report", current === "report")}
      </nav>
      <div className="ml-auto flex items-center gap-6 tabular">{children}</div>
    </header>
  );
}
